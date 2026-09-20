import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config.js";
import type { RpcRequest } from "./app-server/protocol.js";
import { createCodexTestBindingStore } from "./app-server/session-binding.test-helpers.js";
import { clearSharedCodexAppServerClientAndWait } from "./app-server/shared-client.js";
import { CODEX_APP_SERVER_VERSION } from "./app-server/version.js";
import { createCodexSessionCatalogControl } from "./session-catalog-control.js";
import { listCodexSessionCatalog } from "./session-catalog-list-operation.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("hydrates recorded originators through the protocol and serves excluded rows from memory", async () => {
  const home = await fs.realpath(tempDirs.make("openclaw-catalog-originator-peer-"));
  const sessionsRoot = path.join(home, "sessions");
  await fs.mkdir(sessionsRoot);
  const pages = Array.from({ length: 20 }, (_, index) => ({
    id: `managed-${index}`,
    path: path.join(sessionsRoot, `${index}.jsonl`),
    originator: "openclaw",
    source: "vscode",
    status: { type: "notLoaded" },
    name: `Managed ${index}`,
    projectId: null,
  }));
  await Promise.all(
    pages.map((thread) =>
      fs.writeFile(
        thread.path,
        `${JSON.stringify({
          type: "session_meta",
          payload: { id: thread.id, source: thread.source, originator: thread.originator },
        })}\n`,
      ),
    ),
  );
  const rolloutPaths = new Set(pages.map((thread) => thread.path));
  const opening = vi.spyOn(fs, "open");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const methods: string[] = [];
  const cursors: Array<string | undefined> = [];
  const pendingReplies = new Set<ReturnType<typeof setTimeout>>();
  let control: ReturnType<typeof createCodexSessionCatalogControl> | undefined;
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const bytes = Array.isArray(raw)
        ? Buffer.concat(raw)
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : raw;
      const request = JSON.parse(bytes.toString()) as RpcRequest;
      methods.push(request.method);
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { userAgent: `codex/${CODEX_APP_SERVER_VERSION}` },
          }),
        );
        return;
      }
      if (request.method === "initialized") {
        return;
      }
      if (request.method === "thread/list") {
        const params = request.params as { cursor?: string; limit?: number };
        cursors.push(params.cursor);
        const page = Number(params.cursor ?? "0");
        const reply = setTimeout(() => {
          pendingReplies.delete(reply);
          socket.send(
            JSON.stringify({
              id: request.id,
              result: {
                data: [pages[page]],
                nextCursor: page + 1 < pages.length ? String(page + 1) : null,
              },
            }),
          );
        }, 10);
        pendingReplies.add(reply);
        return;
      }
      socket.send(
        JSON.stringify({
          id: request.id,
          error: { code: -32601, message: "Unexpected fixture request" },
        }),
      );
    });
  });

  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the fixture's loopback WebSocket port");
    }
    const config: OpenClawConfig = {
      agents: { list: [{ id: "main", agentDir: path.join(home, "agent") }] },
    };
    const pluginConfig = {
      appServer: {
        transport: "websocket",
        url: `ws://127.0.0.1:${address.port}`,
        homeScope: "agent",
        requestTimeoutMs: 5_000,
      },
    };
    control = createCodexSessionCatalogControl({
      env: { CODEX_HOME: home },
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => config,
      resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
    });
    const source = {
      ...(await control.homesForAgent("main"))[0]!,
      localSessionsRoot: sessionsRoot,
    };
    const started = performance.now();
    await control.forRequest("main", source).initialize();
    const listParams = {
      agentId: "main",
      config,
      bindingStore: createCodexTestBindingStore(),
      runtime: createPluginRuntimeMock(),
      control,
      localHomes: [source],
      query: { hostIds: [source.hostId], limitPerHost: 1 },
      sessionEntries: { entriesForAgent: () => [], entriesForCatalog: () => [] },
    } satisfies Parameters<typeof listCodexSessionCatalog>[0];
    const result = await listCodexSessionCatalog(listParams);
    const openedRollouts = opening.mock.calls.filter(
      ([file]) => typeof file === "string" && rolloutPaths.has(file),
    );
    console.info("catalog-originator-peer", {
      elapsedMs: Math.round(performance.now() - started),
      pageCalls: cursors.length,
      openedRollouts: openedRollouts.length,
      methods,
    });
    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]).toMatchObject({ connected: true, sessions: [] });
    expect(result.hosts[0]).not.toHaveProperty("nextCursor");
    expect(cursors).toEqual(
      Array.from({ length: 20 }, (_, index) => (index === 0 ? undefined : String(index))),
    );
    expect(openedRollouts).toHaveLength(0);
    const nativeRequests = [...methods];
    opening.mockClear();
    expect(await listCodexSessionCatalog(listParams)).toEqual(result);
    expect(methods).toEqual(nativeRequests);
    expect(
      opening.mock.calls.filter(([file]) => typeof file === "string" && rolloutPaths.has(file)),
    ).toHaveLength(0);
  } finally {
    await control?.stop();
    opening.mockRestore();
    await clearSharedCodexAppServerClientAndWait();
    for (const pending of pendingReplies) {
      clearTimeout(pending);
    }
    await Promise.all(
      [...server.clients].map((socket) => {
        const closed = once(socket, "close");
        socket.terminate();
        return closed;
      }),
    );
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    expect(server.clients.size).toBe(0);
    expect(server.address()).toBeNull();
  }
});
