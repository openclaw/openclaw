import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./app-server/client.js";
import { createCodexNativeTestState } from "./app-server/native-app-server.test-support.js";
import type { CodexThreadListResponse } from "./app-server/protocol.js";
import { CODEX_APP_SERVER_VERSION } from "./app-server/version.js";
import { observeCodexCatalogClient } from "./session-catalog-events.js";
import {
  createNativeCatalogPerformanceFixture,
  startNativeCatalogPerformanceClient,
} from "./session-catalog-native-performance.test-support.js";
import {
  commandRpcMocks,
  createCodexSessionCatalogControlFactory,
} from "./session-catalog.test-helpers.js";

it("keeps exact-millisecond ties resident and applies real native title notifications", async () => {
  const root = await fs.realpath(process.env.OPENCLAW_STATE_DIR!);
  const state = await createCodexNativeTestState(root);
  const directory = path.join(state.codexHome, "sessions", "2025", "01", "01");
  await fs.mkdir(directory, { recursive: true });
  const timestamp = "2025-01-01T00:00:00.000Z";
  const ids = Array.from(
    { length: 81 },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  );
  for (const [i, id] of ids.entries()) {
    const file = path.join(directory, `rollout-2025-01-01T00-00-00-${id}.jsonl`);
    await fs.writeFile(
      file,
      [
        {
          timestamp,
          type: "session_meta",
          payload: {
            id,
            timestamp,
            cwd: state.cwd,
            originator: "codex_cli_rs",
            source: "cli",
            cli_version: CODEX_APP_SERVER_VERSION,
            model_provider: "openai",
          },
        },
        {
          timestamp,
          type: "event_msg",
          payload: { type: "user_message", message: `Synthetic tie ${i}`, kind: "plain" },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    // One newer row precedes the otherwise tied native inventory.
    const mtime = i === 0 ? 1_789_520_400 : 1_735_689_600;
    await fs.utimes(file, mtime, mtime);
  }
  const child = spawn(state.command, ["app-server"], {
    cwd: state.cwd,
    env: state.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = CodexAppServerClient.fromTransportForTests(child);
  try {
    await client.initialize();
    const baseline = await client.request<CodexThreadListResponse>("thread/list", {
      limit: 100,
      archived: false,
      modelProviders: [],
      sortKey: "updated_at",
      sortDirection: "desc",
    });
    expect(baseline.data).toHaveLength(81);
    const batches: string[][] = [];
    commandRpcMocks.codexControlRequest.mockImplementation(
      async (_plugin, method, request, options) => {
        expect(method).toBe("thread/list");
        const response = await client.request<CodexThreadListResponse>(method, request, {
          catalogPreview: options.catalogPreview,
          timeoutMs: 10_000,
        });
        batches.push(response.data.map((row) => row.id));
        return response;
      },
    );
    const factory = createCodexSessionCatalogControlFactory({
      env: state.env,
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => undefined,
    });
    const source = (await factory.homesForAgent("main"))[0]!;
    await observeCodexCatalogClient(client, {
      startOptions: source.appServer.start,
      agentDir: source.agentDir,
    });
    const control = factory.forRequest("main", source);
    await control.initialize();
    const first = await control.listPage({ limit: 100 });
    const second = await control.listPage({ limit: 100, cursor: first.nextCursor });
    expect(first.sessions).toHaveLength(64);
    expect(second.sessions).toHaveLength(17);
    expect([...first.sessions, ...second.sessions].map((row) => row.threadId).toSorted()).toEqual(
      ids.toSorted(),
    );

    expect(batches.map((batch) => batch.length)).toEqual([64, 17]);
    batches.length = 0;
    await client.request("thread/name/set", { threadId: ids[0], name: "Changed catalog head" });
    await vi.waitFor(async () => {
      expect((await control.listPage({ limit: 100 })).sessions[0]).toMatchObject({
        threadId: ids[0],
        name: "Changed catalog head",
      });
    });

    const tail = second.sessions[0];
    if (!tail) {
      throw new Error("expected tied tail page");
    }
    await client.request("thread/name/set", { threadId: tail.threadId, name: "Changed tied tail" });
    await vi.waitFor(async () => {
      const current = await control.listPage({ limit: 100, cursor: first.nextCursor });
      expect(current.sessions.find((row) => row.threadId === tail.threadId)?.name).toBe(
        "Changed tied tail",
      );
    });
    const current = await control.listPage({ limit: 100 });
    const remaining = await control.listPage({ limit: 100, cursor: current.nextCursor });
    expect([...current.sessions, ...remaining.sessions].map((row) => row.threadId)).toEqual(
      [...first.sessions, ...second.sessions].map((row) => row.threadId),
    );
    expect(batches).toEqual([]);
  } finally {
    await client.closeAndWait();
  }
}, 30_000);

it("keeps a real native catalog idle until resident demand starts the due full walk", async () => {
  const root = await fs.realpath(process.env.OPENCLAW_STATE_DIR!);
  const state = await createNativeCatalogPerformanceFixture(path.join(root, "idle-safety"), {
    count: 128,
    previewBytes: 64,
  });
  const client = await startNativeCatalogPerformanceClient(state);
  const requests: Array<{ cursor?: string; useStateDbOnly?: boolean }> = [];
  commandRpcMocks.codexControlRequest.mockImplementation(
    async (_plugin, method, request, options) => {
      expect(method).toBe("thread/list");
      requests.push(request);
      return await client.request<CodexThreadListResponse>(method, request, {
        catalogPreview: options.catalogPreview,
        timeoutMs: 10_000,
      });
    },
  );
  const factory = createCodexSessionCatalogControlFactory({
    env: state.env,
    getPluginConfig: () => ({ supervision: { enabled: true } }),
    getRuntimeConfig: () => undefined,
  });
  const source = (await factory.homesForAgent("main"))[0]!;
  const control = factory.forRequest("main", { ...source, localSessionsRoot: undefined });
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  try {
    await control.initialize();
    expect(requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(requests).toHaveLength(2);

    const cached = await control.listPage({ limit: 64 });
    expect(cached.sessions).toHaveLength(64);
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    expect(requests.slice(2).every((request) => request.useStateDbOnly)).toBe(true);
  } finally {
    vi.useRealTimers();
    await factory.stop();
    await client.closeAndWait();
  }
}, 30_000);
