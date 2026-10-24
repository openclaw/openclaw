import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { CodexAppServerClient } from "./app-server/client.js";
import { threadStartResult } from "./app-server/codex-app-server.test-fixtures.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config-runtime.js";
import type { RpcRequest } from "./app-server/protocol.js";
import { createCodexTestBindingStore } from "./app-server/session-binding.test-helpers.js";
import { clearSharedCodexAppServerClientAndWait } from "./app-server/shared-client.js";
import { createClientHarness } from "./app-server/test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./app-server/version.js";
import { createCodexSessionCatalogControl } from "./session-catalog-control.js";
import { createCodexCatalogHomeResolver } from "./session-catalog-homes.js";
import {
  createCodexSessionCatalogListOperation,
  runCatalogListInline,
} from "./session-catalog-list-operation.js";
import { MAX_HOST_COUNT } from "./session-catalog-parsing.js";

const ownerConfig = (
  entries: NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>,
): OpenClawConfig => ({ agents: { ownership: "explicit", entries } });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runtimeOptions = resolveCodexSupervisionAppServerRuntimeOptions;
function catalogOptions(getRuntimeConfig: () => OpenClawConfig, home: string) {
  return {
    config: getRuntimeConfig(),
    getRuntimeConfig,
    getPluginConfig: () => ({}),
    resolveRuntimeOptions: runtimeOptions,
    env: { CODEX_HOME: home },
  };
}

describe("Codex catalog home discovery", () => {
  it.each([
    { homeScope: "agent", initiallyMissing: false, aliasKind: "agent-directory" },
    { homeScope: "user", initiallyMissing: false, aliasKind: "user-home" },
    { homeScope: "agent", initiallyMissing: true, aliasKind: "agent-directory" },
    { homeScope: "agent", initiallyMissing: false, aliasKind: "home-leaf" },
  ] as const)(
    "pins $homeScope/$aliasKind across retarget and restart (missing=$initiallyMissing)",
    async ({ homeScope, initiallyMissing, aliasKind }) => {
      const root = tempDirs.make("codex-catalog-home-alias-");
      const targetsRoot = aliasKind === "home-leaf" ? path.join(root, "agent") : root;
      const homeA = path.join(targetsRoot, "a", "codex-home");
      const homeB = path.join(targetsRoot, "b", "codex-home");
      for (const [home, receipt] of [
        [homeA, "home-a"],
        [homeB, "home-b"],
      ] as const) {
        await fs.mkdir(path.dirname(home), { recursive: true });
        if (!initiallyMissing || home !== homeA) {
          await fs.mkdir(home);
        }
        await fs.writeFile(path.join(path.dirname(home), "receipt"), receipt);
      }
      const canonicalA = path.join(await fs.realpath(path.dirname(homeA)), "codex-home");
      const canonicalB = await fs.realpath(homeB);
      const alias =
        aliasKind === "home-leaf"
          ? path.join(targetsRoot, "codex-home")
          : path.join(root, "selected");
      const linkType = process.platform === "win32" ? "junction" : "dir";
      const aliasTarget = (home: string) =>
        aliasKind === "agent-directory" ? path.dirname(home) : home;
      await fs.symlink(aliasTarget(homeA), alias, linkType);
      let config = ownerConfig({
        alpha: { agentDir: aliasKind === "agent-directory" ? alias : path.join(root, "agent") },
      });
      const factory = createCodexSessionCatalogControl({
        ...catalogOptions(() => config, homeScope === "user" ? alias : path.join(root, "native")),
        getPluginConfig: () => ({
          appServer: { transport: "stdio", homeScope, command: process.execPath },
        }),
      });
      const launchedHomes: string[] = [];
      const threadId = "123e4567-e89b-12d3-a456-426614174001";
      const start = vi.spyOn(CodexAppServerClient, "start").mockImplementation(async (options) => {
        const launchHome = options?.env?.CODEX_HOME;
        if (!launchHome) {
          throw new Error("native catalog startup omitted CODEX_HOME");
        }
        const physicalHome = await fs.realpath(launchHome);
        const receipt = await fs.readFile(path.join(path.dirname(physicalHome), "receipt"), "utf8");
        launchedHomes.push(physicalHome);
        return createClientHarness({
          onWrite: (line, send) => {
            const request = JSON.parse(line) as { id?: number; method: string };
            const respond = (result: unknown) => send({ id: request.id, result });
            if (request.method === "initialize") {
              respond({
                userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}`,
                codexHome: physicalHome,
              });
            } else if (request.method === "thread/read") {
              respond({ thread: { ...threadStartResult(threadId).thread, name: receipt } });
            } else if (request.method !== "initialized") {
              throw new Error(`unexpected catalog request: ${request.method}`);
            }
          },
        }).client;
      });
      const read = (source: Awaited<ReturnType<typeof factory.forNode>>) =>
        source.control.withPinnedConnection(
          async (control) => (await control.readThread(threadId)).name,
        );
      try {
        const captured = await factory.forNode("alpha");
        if (initiallyMissing) {
          await expect(fs.stat(homeA)).rejects.toMatchObject({ code: "ENOENT" });
        }
        await expect(read(captured)).resolves.toBe("home-a");
        expect((await fs.stat(homeA)).isDirectory()).toBe(true);
        await expect(read(captured)).resolves.toBe("home-a");
        expect(launchedHomes).toEqual([canonicalA]);

        await fs.unlink(alias);
        await fs.symlink(aliasTarget(homeB), alias, linkType);
        const candidates = await factory.homesForAgent("alpha");
        expect(candidates[0]).toMatchObject({
          sourceHomeId: captured.sourceHomeId,
          localSessionsRoot: path.join(canonicalA, "sessions"),
          appServer: { start: { homeScope } },
        });
        expect(
          candidates.some((home) => home.localSessionsRoot === path.join(canonicalB, "sessions")),
        ).toBe(false);
        if (homeScope === "agent") {
          expect(candidates[0]?.appServer.start.env?.CODEX_HOME).toBeUndefined();
        }
        await clearSharedCodexAppServerClientAndWait();
        const sameGeneration = await factory.forNode("alpha");
        expect(sameGeneration.sourceHomeId).toBe(captured.sourceHomeId);
        await expect(read(sameGeneration)).resolves.toBe("home-a");
        expect(launchedHomes).toEqual([canonicalA, canonicalA]);

        config = structuredClone(config);
        expect(() => captured.assertCurrent()).toThrow("configuration changed");
        await clearSharedCodexAppServerClientAndWait();
        const replacement = await factory.forNode("alpha");
        expect(replacement.sourceHomeId).not.toBe(captured.sourceHomeId);
        await expect(read(replacement)).resolves.toBe("home-b");
        expect(launchedHomes).toEqual([canonicalA, canonicalA, canonicalB]);
      } finally {
        await factory.stop();
        await clearSharedCodexAppServerClientAndWait();
        start.mockRestore();
      }
    },
  );

  it("leaves agent runtime preparation cold until that owner requests the catalog", async () => {
    const root = tempDirs.make("codex-catalog-lazy-");
    const config = ownerConfig({
      alpha: { agentDir: path.join(root, "alpha") },
      beta: { agentDir: path.join(root, "beta") },
    });
    const resolveRuntimeOptions = vi.fn((options: Parameters<typeof runtimeOptions>[0] = {}) => {
      if (options?.agentDir === path.join(root, "alpha")) {
        throw new Error("alpha runtime is unavailable");
      }
      return runtimeOptions(options);
    });
    const resolver = createCodexCatalogHomeResolver({
      ...catalogOptions(() => config, path.join(root, "native")),
      resolveRuntimeOptions,
    });

    expect(resolveRuntimeOptions).not.toHaveBeenCalled();
    const homes = await resolver.forAgent("beta");
    expect(homes[0]).toMatchObject({ label: "Local Codex", agentDir: path.join(root, "beta") });
    expect(resolveRuntimeOptions).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agentDir: path.join(root, "beta"),
        config,
      }),
    );
  });

  it("stops shared fleet discovery at the existing host limit", async () => {
    const root = tempDirs.make("codex-catalog-limit-");
    const entries: NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]> = {};
    for (let index = 0; index < MAX_HOST_COUNT; index++) {
      const id = `agent-${String(index).padStart(3, "0")}`;
      const agentDir = path.join(root, id);
      await fs.mkdir(path.join(agentDir, "codex-home"), { recursive: true });
      entries[id] = { agentDir };
    }
    const selectedDir = path.join(root, "zzselected");
    await fs.mkdir(path.join(selectedDir, "codex-home"), { recursive: true });
    entries.zzselected = { agentDir: selectedDir };
    const unusedHome = path.join(root, "zzzunused", "codex-home");
    entries.zzzunused = { agentDir: path.dirname(unusedHome) };
    const config = ownerConfig(entries);
    const resolver = createCodexCatalogHomeResolver({
      ...catalogOptions(() => config, path.join(root, "native")),
    });
    const stat = vi.spyOn(fs, "stat");
    try {
      const homes = await resolver.forAgent("zzselected");
      expect(homes).toHaveLength(MAX_HOST_COUNT);
      expect(homes[1]?.label).toBe("Local Codex · zzselected");
      expect(stat.mock.calls.some(([pathname]) => pathname === unusedHome)).toBe(false);
    } finally {
      stat.mockRestore();
    }
  });
});

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
    pages.map(({ path: file, id, source, originator }) =>
      fs.writeFile(
        file,
        `${JSON.stringify({ type: "session_meta", payload: { id, source, originator } })}\n`,
      ),
    ),
  );
  const rolloutPaths = new Set(pages.map((thread) => thread.path));
  const opening = vi.spyOn(fs, "open");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const methods: string[] = [];
  const cursors: Array<string | undefined> = [];
  let control: ReturnType<typeof createCodexSessionCatalogControl> | undefined;
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const bytes = Array.isArray(raw)
        ? Buffer.concat(raw)
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : raw;
      const request = JSON.parse(bytes.toString()) as RpcRequest;
      const send = (result: unknown) => socket.send(JSON.stringify({ id: request.id, result }));
      methods.push(request.method);
      if (request.method === "initialize") {
        send({ userAgent: `codex/${CODEX_APP_SERVER_VERSION}` });
      } else if (request.method === "thread/list") {
        const params = request.params as { cursor?: string; limit?: number };
        cursors.push(params.cursor);
        const page = Number(params.cursor ?? "0");
        send({
          data: [pages[page]],
          nextCursor: page + 1 < pages.length ? String(page + 1) : null,
        });
      } else if (request.method !== "initialized") {
        socket.send(
          JSON.stringify({
            id: request.id,
            error: { code: -32601, message: "Unexpected fixture request" },
          }),
        );
      }
    });
  });

  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the fixture's loopback WebSocket port");
    }
    const config: OpenClawConfig = {
      agents: { entries: { main: { agentDir: path.join(home, "agent") } } },
    };
    control = createCodexSessionCatalogControl({
      ...catalogOptions(() => config, home),
      config: undefined,
      getPluginConfig: () => ({
        appServer: {
          transport: "websocket",
          url: `ws://127.0.0.1:${address.port}`,
          homeScope: "agent",
          requestTimeoutMs: 5_000,
        },
      }),
    });
    const source = {
      ...(await control.homesForAgent("main"))[0]!,
      localSessionsRoot: sessionsRoot,
    };
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
    } satisfies Parameters<typeof createCodexSessionCatalogListOperation>[0];
    const list = () => runCatalogListInline(createCodexSessionCatalogListOperation(listParams));
    const openedRollouts = () =>
      opening.mock.calls.filter(([file]) => typeof file === "string" && rolloutPaths.has(file));
    const result = await list();
    expect(result).toMatchObject([{ connected: true, sessions: [] }]);
    expect(result[0]).not.toHaveProperty("nextCursor");
    expect(cursors).toEqual(
      Array.from({ length: 20 }, (_, index) => (index === 0 ? undefined : String(index))),
    );
    expect(openedRollouts()).toHaveLength(0);
    const nativeRequests = [...methods];
    opening.mockClear();
    expect(await list()).toEqual(result);
    expect(methods).toEqual(nativeRequests);
    expect(openedRollouts()).toHaveLength(0);
  } finally {
    await control?.stop();
    opening.mockRestore();
    await clearSharedCodexAppServerClientAndWait();
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
