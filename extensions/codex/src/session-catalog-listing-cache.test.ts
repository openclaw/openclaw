import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commandRpcMocks,
  createCodexSessionCatalogControl,
  createCodexSessionCatalogControlFactory,
  config,
  idleThread,
  type OpenClawConfig,
} from "./session-catalog.test-helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("Codex catalog resident home sharing", () => {
  it("shares one home inventory across agents, filters, and arbitrary clock advances", async () => {
    let now = 1_000;
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [
        idleThread({ id: "one", source: "cli", cwd: "/workspace/one" }),
        idleThread({ id: "two", source: "cli", cwd: "/workspace/two" }),
      ],
    });
    const factory = createCodexSessionCatalogControlFactory({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
      now: () => now,
    });
    const home = (await factory.homesForAgent("main"))[0]!;
    const first = factory.forRequest("main", { ...home, localSessionsRoot: undefined });
    const second = factory.forRequest("another", { ...home, localSessionsRoot: undefined });
    await first.initialize();
    await expect(first.listPage({ cwd: "/workspace/one" })).resolves.toMatchObject({
      sessions: [expect.objectContaining({ threadId: "one" })],
    });
    now += 24 * 60 * 60 * 1_000;
    await expect(
      second.listPage({ cwd: "/workspace/two", searchTerm: "native" }),
    ).resolves.toMatchObject({
      sessions: [expect.objectContaining({ threadId: "two" })],
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
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
      const control = createCodexSessionCatalogControl({
        getPluginConfig: () => ({ supervision: { enabled: true } }),
        getRuntimeConfig: () => config,
      });
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
        for (const result of await initialized) {
          expect(result).toEqual(
            outcome === "resolve"
              ? { status: "fulfilled", value: undefined }
              : { status: "rejected", reason: failure },
          );
        }
        for (const result of await listed) {
          if (outcome === "resolve") {
            expect(result).toMatchObject({
              status: "fulfilled",
              value: { sessions: [{ threadId: "thread-1" }] },
            });
          } else {
            expect(result).toEqual({ status: "rejected", reason: failure });
          }
        }
        expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
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
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
    });
    await expect(control.initialize()).rejects.toThrow(/repeated.*cursor/);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
  });

  it("captures the current config for requests across agents and homes", async () => {
    let runtimeConfig: OpenClawConfig = {
      agents: { defaults: { workspace: "/workspace/a" } },
    };
    commandRpcMocks.codexControlRequest.mockResolvedValue({ thread: idleThread() });
    const factory = createCodexSessionCatalogControlFactory({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => runtimeConfig,
    });
    const home = (await factory.homesForAgent("main"))[0]!;
    const controls = ["main", "another"].flatMap((agentId) =>
      ["first", "second"].map((sourceHomeId) =>
        factory.forRequest(agentId, { ...home, sourceHomeId }),
      ),
    );
    const initialConfig = runtimeConfig;

    for (const control of controls) {
      await control.readThread("thread-1");
      await control.readThread("thread-1");
    }
    expect(commandRpcMocks.codexControlRequest.mock.calls).toHaveLength(8);
    for (const call of commandRpcMocks.codexControlRequest.mock.calls) {
      expect(call[3]?.config).toEqual(initialConfig);
    }

    runtimeConfig = { agents: { defaults: { workspace: "/workspace/b" } } };
    const reloadedControls = ["main", "another"].map((agentId) => factory.forRequest(agentId));
    for (const control of reloadedControls) {
      await control.readThread("thread-1");
    }
    expect(commandRpcMocks.codexControlRequest.mock.calls).toHaveLength(10);
    for (const call of commandRpcMocks.codexControlRequest.mock.calls.slice(8)) {
      expect(call[3]?.config).toEqual(runtimeConfig);
    }
    expect(commandRpcMocks.codexControlRequest.mock.calls[0]?.[3]?.config).toEqual(initialConfig);
  });

  it("reports a failed initializer and permits its immediate retry", async () => {
    commandRpcMocks.codexControlRequest.mockRejectedValueOnce(new Error("cold failure"));
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
    });

    await expect(control.initialize()).rejects.toThrow("cold failure");
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [idleThread({ id: "thread-recovered", source: "cli" })],
    });
    await control.initialize();
    await expect(control.listPage({ limit: 25 })).resolves.toMatchObject({
      sessions: [expect.objectContaining({ threadId: "thread-recovered" })],
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
  });

  it("keeps a title-search cursor chain on its initial App Server configuration", async () => {
    let pluginConfig = {
      appServer: { command: "codex-initial" },
      supervision: { enabled: true },
    };
    commandRpcMocks.codexControlRequest
      .mockImplementationOnce(async () => {
        pluginConfig = {
          appServer: { command: "codex-reconfigured" },
          supervision: { enabled: true },
        };
        return {
          data: [idleThread({ id: "other", name: "Unrelated", source: "cli" })],
          nextCursor: "page-2",
        };
      })
      .mockResolvedValueOnce({
        data: [idleThread({ id: "match", name: "Match", source: "cli" })],
      });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => config,
    });

    await control.initialize();
    await expect(control.listPage({ limit: 1, searchTerm: "match" })).resolves.toMatchObject({
      sessions: [expect.objectContaining({ threadId: "match" })],
    });
    expect(
      commandRpcMocks.codexControlRequest.mock.calls.map(
        (call) => (call[3]?.startOptions as { command?: string } | undefined)?.command,
      ),
    ).toEqual(["codex-initial", "codex-initial"]);
  });

  it("keeps every Codex interactive source while omitting other custom sources", async () => {
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [
        idleThread({ id: "cli", source: "cli" }),
        idleThread({ id: "vscode", source: "vscode" }),
        idleThread({ id: "atlas", source: { custom: "atlas" } }),
        idleThread({ id: "chatgpt", source: { custom: "chatgpt" } }),
        idleThread({ id: "exec", source: "exec" }),
        idleThread({ id: "app-server", source: "appServer" }),
        idleThread({ id: "subagent", source: { subAgent: "review" } }),
        idleThread({ id: "custom", source: { custom: "integration" } }),
        idleThread({ id: "unknown", source: "unknown" }),
        idleThread({ id: "missing" }),
      ].map((thread, index) => Object.assign(thread, { recencyAt: 100 - index })),
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
    });

    await control.initialize();
    const page = await control.listPage({});

    expect(page.sessions.map((session) => session.threadId)).toEqual([
      "cli",
      "vscode",
      "atlas",
      "chatgpt",
    ]);
    expect(page.sessions.map((session) => session.source)).toEqual([
      "cli",
      "vscode",
      "atlas",
      "chatgpt",
    ]);
  });

  it.each(["nextCursor"] as const)("rejects an oversized native %s", async (cursorField) => {
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [],
      [cursorField]: "x".repeat(4097),
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
    });

    await expect(control.initialize()).rejects.toThrow(
      "Codex catalog response contains an invalid cursor",
    );
  });
});
