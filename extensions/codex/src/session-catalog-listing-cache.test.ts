import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexThread } from "./app-server/protocol.js";
import { catalogFactory, catalogProvider } from "./session-catalog-resident.test-support.js";
import {
  commandRpcMocks,
  createCodexSessionCatalogControl as makeControl,
  config,
  idleThread,
  type OpenClawConfig,
} from "./session-catalog.test-helpers.js";

afterEach(() => vi.restoreAllMocks());

it("discovers visible entries after hidden native pages without rereading the resident head", async () => {
  const rows = Array.from({ length: 35 }, (_, i) =>
    idleThread({
      id: `thread-${i}`,
      source: "cli",
      originator: i < 32 ? "openclaw" : "codex",
      path: `/synthetic/sessions/thread-${i}.jsonl`,
      recencyAt: 10_000 - i,
      updatedAt: 10_000 - i,
    }),
  );
  commandRpcMocks.codexControlRequest.mockImplementation(async (_plugin, _method, request) => {
    const offset = Number(request.cursor ?? 0);
    const data = rows.slice(offset, offset + request.limit);
    const next = offset + data.length;
    return {
      data,
      ...(next < rows.length ? { nextCursor: String(next) } : {}),
    };
  });
  const factory = catalogFactory({
    getRuntimeConfig: () => config,
    now: () => 1_000,
  });
  const primary = (await factory.homesForAgent("main"))[0]!;
  const home = { ...primary, localSessionsRoot: "/synthetic/sessions" };
  const provider = catalogProvider({ ...factory, homesForAgent: async () => [home] });
  const list = (cursor?: string) =>
    provider.list({
      agentId: "main",
      hostIds: [home.hostId],
      limitPerHost: 2,
      ...(cursor ? { cursors: { [home.hostId]: cursor } } : {}),
    });

  await factory.forRequest("main", home).initialize();
  const nativeCalls = commandRpcMocks.codexControlRequest.mock.calls.length;
  expect(nativeCalls).toBeGreaterThan(1);
  const first = await list();
  expect(first[0]).toMatchObject({
    sessions: [{ threadId: "thread-32" }, { threadId: "thread-33" }],
    nextCursor: expect.anything(),
  });
  const tail = await list(first[0]!.nextCursor);
  expect(tail[0]).toMatchObject({ sessions: [{ threadId: "thread-34" }] });
  expect(tail[0]?.nextCursor).toBeUndefined();
  expect(await list()).toEqual(first);
  expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(nativeCalls);
});

it.each(["resolve", "reject"] as const)(
  "waits for the first native page while one shared initializer will %s",
  async (outcome) => {
    const held = createDeferred<unknown>();
    const started = createDeferred<void>();
    commandRpcMocks.codexControlRequest.mockImplementationOnce(() => {
      started.resolve();
      return held.promise;
    });
    const control = makeControl();
    let delivered = 0;
    const lists = [
      { limit: 1 },
      { limit: 2, searchTerm: "native" },
      { cwd: "/workspace/project" },
    ].map((query) => control.listPage(query).finally(() => delivered++));
    const listed = Promise.allSettled(lists);
    const initialized = Promise.allSettled([control.initialize(), control.initialize()]);
    try {
      await started.promise;
      await nextTurn();
      expect(delivered).toBe(0);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
      const failure = new Error("native hydration failed");
      if (outcome === "resolve") {
        held.resolve({ data: [idleThread({ source: "cli" })] });
      } else {
        held.reject(failure);
      }
      const rejected = { status: "rejected", reason: failure };
      expect(await initialized).toEqual(
        Array(2).fill(outcome === "resolve" ? { status: "fulfilled", value: undefined } : rejected),
      );
      for (const result of await listed) {
        expect(result).toMatchObject(
          outcome === "resolve"
            ? {
                status: "fulfilled",
                value: { sessions: [{ threadId: "thread-1" }] },
              }
            : rejected,
        );
      }
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
      if (outcome === "reject") {
        commandRpcMocks.codexControlRequest.mockResolvedValue({
          data: [idleThread({ id: "thread-recovered", source: "cli" })],
        });
        await control.initialize();
        await expect(control.listPage({ limit: 25 })).resolves.toMatchObject({
          sessions: [{ threadId: "thread-recovered" }],
        });
        expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
      }
    } finally {
      held.resolve({ data: [] });
      await Promise.all([initialized, listed]);
    }
  },
);

it("fails a repeated native hydration cursor instead of publishing an incomplete catalog", async () => {
  commandRpcMocks.codexControlRequest.mockResolvedValue({
    data: [idleThread({ source: "cli" })],
    nextCursor: "cycle",
  });
  const control = makeControl();
  await expect(control.initialize()).rejects.toThrow(/repeated.*cursor/);
  expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
});

it("captures the current config for requests across agents and homes", async () => {
  const initial: OpenClawConfig = { agents: { defaults: { workspace: "/workspace/a" } } };
  let runtimeConfig = initial;
  commandRpcMocks.codexControlRequest.mockResolvedValue({ thread: idleThread() });
  const factory = catalogFactory({ getRuntimeConfig: () => runtimeConfig });
  const home = (await factory.homesForAgent("main"))[0]!;
  const controls = ["main", "another"].flatMap((agent) =>
    ["first", "second"].map((sourceHomeId) => factory.forRequest(agent, { ...home, sourceHomeId })),
  );
  for (const control of controls) {
    await control.readThread("thread-1");
    await control.readThread("thread-1");
  }
  const configs = () =>
    commandRpcMocks.codexControlRequest.mock.calls.map((call) => call[3]?.config);
  const firstRequests = Array.from({ length: 8 }, () => initial);
  expect(configs()).toEqual(firstRequests);
  runtimeConfig = { agents: { defaults: { workspace: "/workspace/b" } } };
  for (const agent of ["main", "another"]) {
    await factory.forRequest(agent).readThread("thread-1");
  }
  expect(configs()).toEqual([...firstRequests, runtimeConfig, runtimeConfig]);
});

it("keeps a title-search cursor chain on its initial App Server configuration", async () => {
  const plugin = (command: string) => ({ appServer: { command }, supervision: { enabled: true } });
  let pluginConfig = plugin("codex-initial");
  commandRpcMocks.codexControlRequest
    .mockImplementationOnce(async () => {
      pluginConfig = plugin("codex-reconfigured");
      return {
        data: [idleThread({ id: "other", name: "Unrelated", source: "cli" })],
        nextCursor: "page-2",
      };
    })
    .mockResolvedValueOnce({
      data: [idleThread({ id: "match", name: "Match", source: "cli" })],
    });
  const control = makeControl({
    getPluginConfig: () => pluginConfig,
  });

  await control.initialize();
  await expect(control.listPage({ limit: 1, searchTerm: "match" })).resolves.toMatchObject({
    sessions: [{ threadId: "match" }],
  });
  expect(
    commandRpcMocks.codexControlRequest.mock.calls.map(
      (call) => (call[3]?.startOptions as { command?: string } | undefined)?.command,
    ),
  ).toEqual(["codex-initial", "codex-initial"]);
});

it("keeps every Codex interactive source while omitting other custom sources", async () => {
  const sources: Array<[string, CodexThread["source"]]> = [
    ["cli", "cli"],
    ["vscode", "vscode"],
    ["atlas", { custom: "atlas" }],
    ["chatgpt", { custom: "chatgpt" }],
    ["exec", "exec"],
    ["app-server", "appServer"],
    ["subagent", { subAgent: "review" }],
    ["custom", { custom: "integration" }],
    ["unknown", "unknown"],
    ["missing", undefined],
  ];
  commandRpcMocks.codexControlRequest.mockResolvedValue({
    data: sources.map(([id, source], index) => idleThread({ id, source, recencyAt: 100 - index })),
  });
  const control = makeControl();

  await control.initialize();
  const page = await control.listPage({});

  expect(page.sessions.map(({ threadId, source }) => [threadId, source])).toEqual(
    ["cli", "vscode", "atlas", "chatgpt"].map((source) => [source, source]),
  );
});

it("rejects an oversized native nextCursor", async () => {
  commandRpcMocks.codexControlRequest.mockResolvedValue({
    data: [],
    nextCursor: "x".repeat(4097),
  });
  const control = makeControl();

  await expect(control.initialize()).rejects.toThrow(
    "Codex catalog response contains an invalid cursor",
  );
});
