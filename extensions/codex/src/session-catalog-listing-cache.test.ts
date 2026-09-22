// Codex supervision tests cover passive listing and safe local session takeover.
import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type { CodexSessionCatalogControl } from "./session-catalog-types.js";
import {
  commandRpcMocks,
  createCodexSessionCatalogControl,
  createCodexSessionCatalogControlFactory,
  config,
  idleThread,
  resolveDefaultAgentDir,
  type OpenClawConfig,
} from "./session-catalog.test-helpers.js";

async function fillPageCache(control: CodexSessionCatalogControl) {
  for (let index = 0; index < 32; index += 1) {
    await control.listPage({ cursor: `pressure-${index}`, limit: 1 });
  }
}

describe("Codex supervision catalog", () => {
  it("reuses native pages across repeated multi-home exclusion walks", async () => {
    const { listVisiblePage } = await import("./session-catalog-visible-page.js");
    commandRpcMocks.codexControlRequest.mockImplementation(
      async (
        _pluginConfig: unknown,
        _method: string,
        request: { cursor?: string },
        options: { agentDir: string },
      ) => {
        const page = Number(request.cursor ?? 0);
        return {
          data: [
            idleThread({
              id: page === 19 ? `visible-${options.agentDir}` : "managed",
              source: "cli",
            }),
          ],
          ...(page < 19 ? { nextCursor: String(page + 1) } : {}),
        };
      },
    );
    const factory = createCodexSessionCatalogControlFactory({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
      now: () => 1_000,
    });
    const primary = (await factory.homesForAgent("main"))[0]!;
    const controls = ["one", "two", "three", "four", "five", "six", "seven"].map((homeId) =>
      factory.forRequest("main", {
        ...primary,
        sourceHomeId: homeId,
        agentDir: `/agents/${homeId}`,
      }),
    );
    const list = async (selectedControls = controls) => {
      const pages = [];
      // Serial homes preserve the scan order without racing Vitest's cold dynamic mocks.
      for (const control of selectedControls) {
        pages.push(
          await listVisiblePage({ control, excludedThreadIds: new Set(["managed"]), limit: 1 }),
        );
      }
      return pages;
    };

    const first = await list();
    expect(first.map((page) => page.sessions.map((session) => session.threadId))).toEqual([
      ["visible-/agents/one"],
      ["visible-/agents/two"],
      ["visible-/agents/three"],
      ["visible-/agents/four"],
      ["visible-/agents/five"],
      ["visible-/agents/six"],
      ["visible-/agents/seven"],
    ]);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(140);
    await expect(list()).resolves.toEqual(first);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(140);

    await fillPageCache(controls[0]!);
    await expect(list(controls.slice(1))).resolves.toEqual(first.slice(1));
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(172);
  });

  it("memoizes cloned request options until runtime config identity changes", async () => {
    let runtimeConfig = { agents: { defaults: { workspace: "/workspace/a" } } } as OpenClawConfig;
    commandRpcMocks.codexControlRequest.mockResolvedValue({ thread: idleThread() });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => runtimeConfig,
    });
    const cloneSpy = vi.spyOn(globalThis, "structuredClone");

    await control.readThread("thread-1");
    await control.readThread("thread-1");
    expect(cloneSpy).toHaveBeenCalledTimes(2);

    runtimeConfig = { agents: { defaults: { workspace: "/workspace/b" } } } as OpenClawConfig;
    await control.readThread("thread-1");
    expect(cloneSpy).toHaveBeenCalledTimes(4);
  });

  it.each([false, true])(
    "refreshes expired pages without blocking delivery (head: %s)",
    async (headWalk) => {
      let now = 1_000;
      let runtimeConfig = {} as OpenClawConfig;
      commandRpcMocks.codexControlRequest.mockResolvedValue({
        data: [idleThread({ id: "thread-stale", source: "cli" })],
      });
      const control = createCodexSessionCatalogControl({
        getPluginConfig: () => ({ supervision: { enabled: true } }),
        getRuntimeConfig: () => runtimeConfig,
        now: () => now,
      });

      const list = () => control.listPage({ limit: 25 }, undefined, { headWalk });
      await list();
      await list();
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();

      now += 31_999;
      await list();
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();

      now += 2;
      let resolveRefresh!: (value: unknown) => void;
      let refreshSettled = false;
      const refresh = new Promise<unknown>((resolve) => {
        resolveRefresh = resolve;
      }).then((value) => {
        refreshSettled = true;
        return value;
      });
      let markRefreshStarted!: () => void;
      const refreshStarted = new Promise<void>((resolve) => {
        markRefreshStarted = resolve;
      });
      commandRpcMocks.codexControlRequest.mockImplementationOnce(() => {
        markRefreshStarted();
        return refresh;
      });
      const firstExpiredPoll = list();
      const overlappingExpiredPoll = list();

      await expect(Promise.all([firstExpiredPoll, overlappingExpiredPoll])).resolves.toEqual([
        expect.objectContaining({
          sessions: [expect.objectContaining({ threadId: "thread-stale" })],
        }),
        expect.objectContaining({
          sessions: [expect.objectContaining({ threadId: "thread-stale" })],
        }),
      ]);
      expect(refreshSettled).toBe(false);
      // Stale delivery does not wait for the deferred RPC module to start its request.
      await refreshStarted;
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);

      resolveRefresh({ data: [idleThread({ id: "thread-refreshed", source: "cli" })] });
      await vi.waitFor(async () => {
        await expect(list()).resolves.toMatchObject({
          sessions: [expect.objectContaining({ threadId: "thread-refreshed" })],
        });
      });
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);

      runtimeConfig = { agents: {} } as OpenClawConfig;
      await list();
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(3);
    },
  );

  it("serves the last real page after a refresh failure and retries the next poll", async () => {
    let now = 1_000;
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [idleThread({ id: "thread-stale", source: "cli" })],
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
      now: () => now,
    });
    const first = await control.listPage({ limit: 25 });

    now += 32_001;
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    commandRpcMocks.codexControlRequest.mockImplementationOnce(async () => {
      markRefreshStarted();
      now = 500; // A clock correction must not make the failed stale page fresh again.
      throw new Error("app-server unavailable");
    });
    await expect(control.listPage({ limit: 25 })).resolves.toEqual(first);
    await refreshStarted;
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);

    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [idleThread({ id: "thread-recovered", source: "cli" })],
    });
    await expect(control.listPage({ limit: 25 })).resolves.toEqual(first);
    await vi.waitFor(async () => {
      await expect(control.listPage({ limit: 25 })).resolves.toMatchObject({
        sessions: [expect.objectContaining({ threadId: "thread-recovered" })],
      });
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(3);
  });

  it("evicts a cold failed page so the next caller retries immediately", async () => {
    commandRpcMocks.codexControlRequest.mockRejectedValueOnce(new Error("cold failure"));
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
    });

    await expect(control.listPage({ limit: 25 })).rejects.toThrow("cold failure");
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [idleThread({ id: "thread-recovered", source: "cli" })],
    });
    await expect(control.listPage({ limit: 25 })).resolves.toMatchObject({
      sessions: [expect.objectContaining({ threadId: "thread-recovered" })],
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
  });

  it.each(["resolve", "reject"] as const)(
    "shares a pending cold page through distinct-query pressure until %s",
    async (outcome) => {
      const held = createDeferred<unknown>();
      const started = createDeferred<void>();
      let heldRequests = 0;
      commandRpcMocks.codexControlRequest.mockImplementation(
        (_pluginConfig: unknown, _method: string, request: { cursor?: string }) => {
          if (request.cursor === "held") {
            heldRequests += 1;
            started.resolve();
            return held.promise;
          }
          return { data: [idleThread({ id: request.cursor, source: "cli" })] };
        },
      );
      const control = createCodexSessionCatalogControl({
        getPluginConfig: () => ({ supervision: { enabled: true } }),
        getRuntimeConfig: () => config,
        now: () => 1_000,
      });
      const query = { cursor: "held", limit: 1 };
      const first = control.listPage(query);
      const pending = [first];
      const failure = new Error("native page failed");
      try {
        await started.promise;
        await fillPageCache(control);
        pending.push(control.listPage(query));
        const results = Promise.allSettled(pending);
        if (outcome === "resolve") {
          held.resolve({ data: [idleThread({ id: "held-result", source: "cli" })] });
        } else {
          held.reject(failure);
        }
        const settled = await results;
        expect.soft(heldRequests).toBe(1);
        if (outcome === "resolve") {
          expect(settled[0]).toMatchObject({ status: "fulfilled" });
          expect(settled[1]).toEqual(settled[0]);
        } else {
          expect(settled).toEqual([
            { status: "rejected", reason: failure },
            { status: "rejected", reason: failure },
          ]);
          commandRpcMocks.codexControlRequest.mockResolvedValue({
            data: [idleThread({ id: "recovered", source: "cli" })],
          });
          await expect(control.listPage(query)).resolves.toMatchObject({
            sessions: [expect.objectContaining({ threadId: "recovered" })],
          });
        }
      } finally {
        held.resolve({ data: [] });
        await Promise.allSettled(pending);
      }
    },
  );

  it.each(["resolve", "reject"] as const)(
    "keeps stale delivery during an evicted page's refresh until %s",
    async (outcome) => {
      let now = 1_000;
      commandRpcMocks.codexControlRequest.mockResolvedValue({
        data: [idleThread({ id: "stale-result", source: "cli" })],
      });
      const control = createCodexSessionCatalogControl({
        getPluginConfig: () => ({ supervision: { enabled: true } }),
        getRuntimeConfig: () => config,
        now: () => now,
      });
      const query = { cursor: "held", limit: 1 };
      const stale = await control.listPage(query);
      const refresh = createDeferred<unknown>();
      const started = createDeferred<void>();
      let refreshRequests = 0;
      commandRpcMocks.codexControlRequest.mockImplementation(
        (_pluginConfig: unknown, _method: string, request: { cursor?: string }) => {
          if (request.cursor === "held") {
            refreshRequests += 1;
            started.resolve();
            return refresh.promise;
          }
          return { data: [idleThread({ id: request.cursor, source: "cli" })] };
        },
      );
      now += 32_001;
      let follower: ReturnType<typeof control.listPage> | undefined;
      try {
        await expect(control.listPage(query)).resolves.toEqual(stale);
        await started.promise;
        await fillPageCache(control);
        let delivered = false;
        follower = control.listPage(query).then((page) => {
          delivered = true;
          return page;
        });
        await nextTurn();
        expect.soft(delivered).toBe(true);
        expect.soft(refreshRequests).toBe(1);
        if (outcome === "resolve") {
          refresh.resolve({ data: [idleThread({ id: "refreshed", source: "cli" })] });
        } else {
          refresh.reject(new Error("native refresh failed"));
        }
        await expect(follower).resolves.toEqual(stale);
        await nextTurn();
        commandRpcMocks.codexControlRequest.mockResolvedValue({
          data: [idleThread({ id: "retried", source: "cli" })],
        });
        await expect(control.listPage(query)).resolves.toMatchObject({
          sessions: [
            expect.objectContaining({
              threadId: outcome === "resolve" ? "refreshed" : "retried",
            }),
          ],
        });
      } finally {
        refresh.resolve({ data: [] });
        await Promise.allSettled(follower ? [follower] : []);
        await nextTurn();
      }
    },
  );

  it.each([false, true])(
    "bounds settled pages and refreshes recency across queries (head: %s)",
    async (headWalk) => {
      commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [] });
      const control = createCodexSessionCatalogControl({
        getPluginConfig: () => ({ supervision: { enabled: true } }),
        getRuntimeConfig: () => config,
        now: () => 1_000,
      });
      const queries = Array.from({ length: 32 }, (_, index) => ({
        cursor: `pressure-${index}`,
        limit: index + 1,
        searchTerm: `title-${index}`,
        cwd: `/workspace/project-${index}`,
      }));
      const list = (query: (typeof queries)[number]) =>
        control.listPage(query, undefined, { headWalk });
      for (const query of queries) {
        await list(query);
      }
      await list(queries[0]!);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(32);
      await list({ ...queries[0]!, cursor: "newest" });
      await list(queries[0]!);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(33);
      await list(queries[1]!);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(34);
    },
  );

  it("keeps pending page settlement within its captured config", async () => {
    let runtimeConfig = {} as OpenClawConfig;
    const oldPage = createDeferred<unknown>();
    const newPage = createDeferred<unknown>();
    const oldStarted = createDeferred<void>();
    const newStarted = createDeferred<void>();
    commandRpcMocks.codexControlRequest
      .mockImplementationOnce(() => {
        oldStarted.resolve();
        return oldPage.promise;
      })
      .mockImplementationOnce(() => {
        newStarted.resolve();
        return newPage.promise;
      });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => runtimeConfig,
    });
    const first = control.listPage({ limit: 1 });
    const pending = [first];
    try {
      await oldStarted.promise;
      runtimeConfig = {};
      const replacement = control.listPage({ limit: 1 });
      pending.push(replacement);
      await newStarted.promise;
      newPage.resolve({ data: [idleThread({ id: "replacement", source: "cli" })] });
      const current = await replacement;
      oldPage.resolve({ data: [idleThread({ id: "retired", source: "cli" })] });
      await first;
      await expect(control.listPage({ limit: 1 })).resolves.toEqual(current);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
    } finally {
      oldPage.resolve({ data: [] });
      newPage.resolve({ data: [] });
      await Promise.allSettled(pending);
    }
  });

  it("scans bounded native pages for complete title-only search results", async () => {
    const pluginConfig = { supervision: { enabled: true } };
    commandRpcMocks.codexControlRequest.mockImplementation(
      async (_pluginConfig: unknown, _method: string, request: Record<string, unknown>) => {
        if (request.cursor === "page-3") {
          return {
            data: [idleThread({ id: "match-2", name: "MATCH two", source: "vscode" })],
          };
        }
        if (request.cursor === "page-2") {
          return {
            data: [
              idleThread({ id: "match-1", name: "Match one", source: "cli" }),
              idleThread({ id: "private-2", name: "Other", source: "cli" }),
            ],
            nextCursor: "page-3",
          };
        }
        return {
          data: [idleThread({ id: "private-1", name: "Unrelated", source: "cli" })],
          nextCursor: "page-2",
          backwardsCursor: "previous-page",
        };
      },
    );
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => config,
    });

    await expect(control.listPage({ limit: 2, searchTerm: "match" })).resolves.toEqual({
      scannedPages: 3,
      sessions: [
        expect.objectContaining({ threadId: "match-1", name: "Match one" }),
        expect.objectContaining({ threadId: "match-2", name: "MATCH two" }),
      ],
      backwardsCursor: "previous-page",
    });
    expect(commandRpcMocks.codexControlRequest.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({ limit: 2 }),
      expect.objectContaining({ cursor: "page-2", limit: 2 }),
      expect.objectContaining({ cursor: "page-3", limit: 1 }),
    ]);
    for (const call of commandRpcMocks.codexControlRequest.mock.calls) {
      expect(call[2]).not.toHaveProperty("searchTerm");
    }
  });

  it("returns the last native cursor when a title search reaches its scan cap", async () => {
    let page = 0;
    commandRpcMocks.codexControlRequest.mockImplementation(async () => {
      page += 1;
      return {
        data: [idleThread({ id: `private-${page}`, name: "Unrelated", source: "cli" })],
        nextCursor: `page-${page}`,
      };
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
    });

    await expect(control.listPage({ limit: 10, searchTerm: "match" })).resolves.toEqual({
      sessions: [],
      scannedPages: 20,
      nextCursor: "page-20",
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(20);
  });

  it("fails closed when title-search cursors cycle", async () => {
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [idleThread({ name: "Unrelated", source: "cli" })],
      nextCursor: "cycle",
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
    });

    await expect(control.listPage({ limit: 10, searchTerm: "match" })).rejects.toThrow(
      "repeated search cursor",
    );
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
  });

  it.each(["pending", "settled"])(
    "keeps a smaller search budget independent of a %s page",
    async (state) => {
      const held = createDeferred<unknown>();
      const started = createDeferred<void>();
      const response = (cursor: number) => ({
        data: [idleThread({ id: `other-${cursor}`, name: "Other", source: "cli" })],
        nextCursor: String(cursor + 1),
      });
      commandRpcMocks.codexControlRequest
        .mockImplementationOnce(() => {
          started.resolve();
          return held.promise;
        })
        .mockImplementation(async (_plugin, _method, request) => response(Number(request.cursor)));
      const control = createCodexSessionCatalogControl({
        getPluginConfig: () => ({ supervision: { enabled: true } }),
        getRuntimeConfig: () => config,
        now: () => 1_000,
      });
      const query = { cursor: "0", limit: 1, searchTerm: "Wanted" };
      let largerSettled = false;
      const larger = control.listPage(query, undefined, { maxScanPages: 3 }).finally(() => {
        largerSettled = true;
      });
      const pending = [larger];
      try {
        await started.promise;
        if (state === "settled") {
          held.resolve(response(0));
          await larger;
        }
        const smaller = control.listPage(query, undefined, { maxScanPages: 1 });
        pending.push(smaller);
        // Keep the native response held across the second producer's asynchronous setup.
        await nextTurn();
        expect(largerSettled).toBe(state === "settled");
        held.resolve(response(0));
        await expect(smaller).resolves.toEqual({ sessions: [], nextCursor: "1" });
        await expect(larger).resolves.toEqual({
          sessions: [],
          scannedPages: 3,
          nextCursor: "3",
        });
      } finally {
        held.resolve(response(0));
        await Promise.allSettled(pending);
      }
    },
  );

  it("shares one timeout budget across title-search pages", async () => {
    let elapsedMs = 0;
    let page = 0;
    commandRpcMocks.codexControlRequest.mockImplementation(async () => {
      page += 1;
      elapsedMs += 600;
      return {
        data: [idleThread({ id: `other-${page}`, name: "Unrelated", source: "cli" })],
        nextCursor: `page-${page}`,
      };
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({
        appServer: { requestTimeoutMs: 1_000 },
        supervision: { enabled: true },
      }),
      getRuntimeConfig: () => config,
      now: () => elapsedMs,
    });

    await expect(control.listPage({ limit: 10, searchTerm: "match" })).rejects.toThrow(
      "catalog listing timed out",
    );
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
    expect(
      commandRpcMocks.codexControlRequest.mock.calls.map((call) => call[3]?.timeoutMs),
    ).toEqual([1_000, 400]);
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

    await expect(control.listPage({ limit: 1, searchTerm: "match" })).resolves.toMatchObject({
      sessions: [expect.objectContaining({ threadId: "match" })],
    });
    expect(
      commandRpcMocks.codexControlRequest.mock.calls.map(
        (call) => (call[3]?.startOptions as { command?: string } | undefined)?.command,
      ),
    ).toEqual(["codex-initial", "codex-initial"]);
  });

  it("rejects an oversized direct catalog cursor before native I/O", async () => {
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
    });

    await expect(control.listPage({ cursor: "x".repeat(4097) })).rejects.toThrow(
      "invalid Codex session catalog request cursor",
    );
    expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
  });

  it.each(["nextCursor", "backwardsCursor"] as const)(
    "rejects an oversized native %s",
    async (cursorField) => {
      commandRpcMocks.codexControlRequest.mockResolvedValue({
        data: [],
        [cursorField]: "x".repeat(4097),
      });
      const control = createCodexSessionCatalogControl({
        getPluginConfig: () => ({ supervision: { enabled: true } }),
        getRuntimeConfig: () => config,
      });

      await expect(control.listPage({})).rejects.toThrow(
        `invalid Codex session catalog ${cursorField === "nextCursor" ? "next" : "backwards"} response cursor`,
      );
    },
  );

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
      ],
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
    });

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

  it("keeps takeover forking out of the passive catalog control", async () => {
    const pluginConfig = { supervision: { enabled: true } };
    const response = { thread: idleThread({ id: "thread-source" }) };
    commandRpcMocks.codexControlRequest.mockResolvedValue(response);
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => config,
    });

    await expect(control.readThread("thread-source", true)).resolves.toBe(response.thread);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledWith(
      pluginConfig,
      "thread/read",
      { threadId: "thread-source", includeTurns: true },
      {
        agentDir: resolveDefaultAgentDir(config),
        config,
        authProfileId: null,
        startOptions: expect.objectContaining({ transport: "stdio", homeScope: "user" }),
      },
    );
    expect(commandRpcMocks.codexControlRequest.mock.calls.map((call) => call[1])).not.toContain(
      "thread/fork",
    );
  });

  it("keeps catalog reads and writes available when supervision is disabled live", async () => {
    let pluginConfig: unknown = { supervision: { enabled: true } };
    let runtimeConfig = {} as OpenClawConfig;
    commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [] });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => runtimeConfig,
    });

    await expect(control.listPage({})).resolves.toEqual({ sessions: [] });
    pluginConfig = { supervision: { enabled: false } };
    runtimeConfig = { plugins: {} } as OpenClawConfig;

    await expect(control.listPage({})).resolves.toEqual({ sessions: [] });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
  });

  it("keeps an in-flight catalog independent of supervision changes", async () => {
    let pluginConfig: unknown = { supervision: { enabled: true } };
    commandRpcMocks.codexControlRequest.mockImplementation(async () => {
      pluginConfig = { supervision: { enabled: false } };
      return {
        data: [idleThread({ id: "other", name: "Unrelated", source: "cli" })],
        nextCursor: "page-2",
      };
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => config,
    });

    commandRpcMocks.codexControlRequest.mockImplementationOnce(async () => {
      pluginConfig = { supervision: { enabled: false } };
      return { data: [] };
    });
    await expect(control.listPage({ limit: 10, searchTerm: "match" })).resolves.toEqual({
      sessions: [],
    });
  });
});
