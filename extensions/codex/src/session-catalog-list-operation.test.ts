import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { SessionCatalogProvider } from "openclaw/plugin-sdk/session-catalog";
import { describe, expect, it, vi } from "vitest";
import { CODEX_TERMINAL_START_COMMAND } from "./session-catalog-terminal.js";
import type {
  CodexSessionCatalogPage,
  CodexSessionCatalogPageParams,
} from "./session-catalog-types.js";
import {
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  config,
  createCodexSessionCatalogControlFactory,
  createCodexTestBindingStore,
  createControl,
  createGatewayApi,
  createRuntime,
  registerCodexSessionCatalog,
} from "./session-catalog.test-helpers.js";

function page(ids: string[], nextCursor?: string): CodexSessionCatalogPage {
  return {
    sessions: ids.map((threadId) => ({
      threadId,
      name: threadId,
      status: "idle",
      source: "cli",
      archived: false,
    })),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function observe<T>(promise: Promise<T>) {
  const state = { settled: false };
  const done = promise
    .then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    )
    .finally(() => {
      state.settled = true;
    });
  return { state, done };
}

async function fixture(homeCount = 1) {
  const { runtime } = createRuntime();
  const base = createCodexSessionCatalogControlFactory({
    getPluginConfig: () => ({ supervision: { enabled: true } }),
    getRuntimeConfig: () => config,
  });
  const primary = (await base.homesForAgent("main"))[0]!;
  const homes = Array.from({ length: homeCount }, (_, index) => ({
    ...primary,
    sourceHomeId: `home-${index}`,
    hostId: index === 0 ? "gateway:local" : `gateway:local:home-${index}`,
    label: `Home ${index}`,
  }));
  const listPage =
    vi.fn<
      (homeId: string, params: CodexSessionCatalogPageParams) => Promise<CodexSessionCatalogPage>
    >();
  listPage.mockResolvedValue(page(["visible"]));
  const snapshot = vi.fn(
    async () => new Map(homes.map((home) => [home.sourceHomeId, new Set(["managed"])])),
  );
  const bindingStore = Object.assign(createCodexTestBindingStore(), {
    managedThreads: { has: vi.fn(async () => false), mark: vi.fn(async () => true), snapshot },
  });
  const { api, getProvider } = createGatewayApi(runtime, config);
  registerCodexSessionCatalog({
    api,
    bindingStore,
    control: {
      ...base,
      homesForAgent: async () => homes,
      forRequest: (_agentId, source) =>
        createControl({
          listPage: (params) => listPage(source!.sourceHomeId, params),
        }),
    },
    getRuntimeConfig: () => config,
  });
  const controller = new AbortController();
  const onHost = vi.fn();
  const publications: Promise<void>[] = [];
  const start = (params: Partial<Parameters<SessionCatalogProvider["list"]>[0]> = {}) => {
    const provider = getProvider()!;
    if (!provider.createListOperation) {
      throw new Error("Codex list operation is unavailable");
    }
    return provider.createListOperation({
      agentId: "main",
      limitPerHost: 1,
      hostIds: homes.map((home) => home.hostId),
      signal: controller.signal,
      onHost,
      waitUntil: (completion) => {
        publications.push(completion);
      },
      ...params,
    });
  };
  return { runtime, homes, listPage, snapshot, controller, onHost, publications, start };
}

describe("Codex catalog list operation", () => {
  it("yields an inert exclusion checkpoint and retains filled rows, limits and cursors", async () => {
    const f = await fixture();
    f.listPage
      .mockResolvedValueOnce({
        ...page(["keep-one"], "next"),
        managedThreads: [{ threadId: "managed" }],
        backwardsCursor: "previous",
      })
      .mockResolvedValueOnce(page(["keep-two"], "remaining"));
    const operation = f.start({ limitPerHost: 2, search: "keep" });
    try {
      expect(f.snapshot).not.toHaveBeenCalled();
      expect(f.listPage).not.toHaveBeenCalled();
      await expect(operation.next()).resolves.toEqual({ done: false });
      expect(f.listPage.mock.calls).toEqual([["home-0", { limit: 2, searchTerm: "keep" }]]);
      expect(f.onHost).not.toHaveBeenCalled();
      expect(f.publications).toHaveLength(1);
      const published = observe(f.publications[0]!);
      await nextTurn();
      expect(published.state.settled).toBe(false);

      const result = await operation.next();
      expect(result.done).toBe(true);
      if (!result.done) {
        throw new Error("filled result missing");
      }
      expect(result.hosts[0]?.sessions.map((row) => row.threadId)).toEqual([
        "keep-one",
        "keep-two",
      ]);
      expect(result.hosts[0]?.nextCursor).toBe("remaining");
      expect(f.listPage.mock.calls[1]).toEqual([
        "home-0",
        { limit: 1, cursor: "next", searchTerm: "keep" },
      ]);
      await Promise.all(f.publications);
      expect(f.onHost).toHaveBeenCalledOnce();
      expect(f.onHost).toHaveBeenCalledWith(result.hosts[0]);
    } finally {
      operation.close();
      await Promise.allSettled(f.publications);
    }
  });

  it("closes uninitialized and paused operations without starting or reviving source work", async () => {
    const f = await fixture();
    const untouched = f.start();
    expect(untouched.close()).toBeUndefined();
    await expect(untouched.next()).rejects.toThrow();
    expect(f.snapshot).not.toHaveBeenCalled();
    f.listPage.mockResolvedValue(page(["managed"], "next"));
    const operation = f.start();
    try {
      await expect(operation.next()).resolves.toEqual({ done: false });
      expect(operation.close()).toBeUndefined();
      expect(operation.close()).toBeUndefined();
      await expect(operation.next()).rejects.toThrow();
      const publications = await Promise.allSettled(f.publications);
      expect(publications).toHaveLength(1);
      expect(publications[0]?.status).toBe("rejected");
      expect(f.onHost).not.toHaveBeenCalled();
      expect(f.listPage).toHaveBeenCalledOnce();
    } finally {
      operation.close();
      await Promise.allSettled(f.publications);
    }
  });

  it("joins a held control page after active abort before allowing closure", async () => {
    const f = await fixture();
    const held = createDeferred<CodexSessionCatalogPage>();
    const started = createDeferred<void>();
    f.listPage.mockImplementation(() => {
      started.resolve();
      return held.promise;
    });
    const operation = f.start();
    const advancing = observe(operation.next());
    try {
      await started.promise;
      f.controller.abort(new Error("catalog retired"));
      await nextTurn();
      expect(advancing.state.settled).toBe(false);
      held.resolve(page(["managed"], "next"));
      await expect(advancing.done).resolves.toMatchObject({
        status: "fulfilled",
        value: { done: true, hosts: [{ error: { code: "APP_SERVER_UNAVAILABLE" } }] },
      });
      operation.close();
      expect(f.listPage).toHaveBeenCalledOnce();
    } finally {
      held.resolve(page([]));
      await advancing.done;
      operation.close();
      await Promise.allSettled(f.publications);
    }
  });

  it.each(["resolve", "reject"] as const)(
    "leaves an asynchronous %s publication tail with waitUntil",
    async (outcome) => {
      const f = await fixture();
      const publication = createDeferred<void>();
      const published = createDeferred<void>();
      const operation = f.start({
        // oxlint-disable-next-line typescript/no-misused-promises -- The void SDK callback can return a JS promise that publication must retain.
        onHost: () => {
          published.resolve();
          return publication.promise;
        },
      });
      const advancing = observe(operation.next());
      const error = new Error("publication failed");
      try {
        await published.promise;
        await nextTurn();
        expect.soft(advancing.state.settled).toBe(true);
        if (advancing.state.settled) {
          operation.close();
        }
        if (outcome === "resolve") {
          publication.resolve();
        } else {
          publication.reject(error);
        }
        await expect(advancing.done).resolves.toMatchObject({
          status: "fulfilled",
          value: { done: true, hosts: [{ connected: true }] },
        });
        const tails = await Promise.allSettled(f.publications);
        expect(tails).toEqual(
          outcome === "resolve"
            ? [{ status: "fulfilled", value: undefined }]
            : [{ status: "rejected", reason: error }],
        );
        expect(f.listPage).toHaveBeenCalledOnce();
      } finally {
        publication.resolve();
        await advancing.done;
        operation.close();
        await Promise.allSettled(f.publications);
      }
    },
  );

  it("lets a fast home refill and publish while another home's first page stays active", async () => {
    const f = await fixture(2);
    const first = createDeferred<CodexSessionCatalogPage>();
    const slow = createDeferred<CodexSessionCatalogPage>();
    let slowStarted = false;
    let fastPublished = false;
    f.listPage.mockImplementation(async (home, params) => {
      if (home === "home-1") {
        slowStarted = true;
        return slow.promise;
      }
      return params.cursor ? page(["fast-visible"]) : first.promise;
    });
    const operation = f.start({
      onHost: (host) => {
        if (host.hostId === f.homes[0]!.hostId) {
          fastPublished = true;
        }
      },
    });
    const advancing = observe(operation.next());
    try {
      await vi.waitFor(() => expect(slowStarted).toBe(true));
      first.resolve(page(["managed"], "next"));
      await vi.waitFor(() => expect(fastPublished).toBe(true));
      expect(f.listPage.mock.calls.filter(([home]) => home === "home-0")).toHaveLength(2);
      expect(advancing.state.settled).toBe(false);
      slow.resolve(page(["slow-visible"]));
      await expect(advancing.done).resolves.toMatchObject({
        status: "fulfilled",
        value: {
          done: true,
          hosts: [
            { hostId: f.homes[0]!.hostId, sessions: [{ threadId: "fast-visible" }] },
            { hostId: f.homes[1]!.hostId, sessions: [{ threadId: "slow-visible" }] },
          ],
        },
      });
    } finally {
      first.resolve(page([]));
      slow.resolve(page([]));
      await advancing.done;
      operation.close();
      await Promise.allSettled(f.publications);
    }
  });

  it("continues inline during unknown discovery and yields only after an actual empty selection", async () => {
    const f = await fixture();
    const discovery = createDeferred<{ nodes: [] }>();
    const second = createDeferred<CodexSessionCatalogPage>();
    let secondStarted = false;
    f.listPage.mockImplementation(async (_home, params) => {
      if (params.cursor === "second") {
        secondStarted = true;
        return second.promise;
      }
      return params.cursor === "third" ? page(["visible"]) : page(["managed"], "second");
    });
    const operation = f.start({ hostIds: undefined, listNodes: () => discovery.promise });
    const advancing = observe(operation.next());
    try {
      await vi.waitFor(() => expect(secondStarted).toBe(true));
      expect(advancing.state.settled).toBe(false);
      discovery.resolve({ nodes: [] });
      await nextTurn();
      second.resolve(page(["managed"], "third"));
      await expect(advancing.done).resolves.toEqual({
        status: "fulfilled",
        value: { done: false },
      });
      expect(f.listPage).toHaveBeenCalledTimes(2);
      await expect(operation.next()).resolves.toMatchObject({
        done: true,
        hosts: [{ sessions: [{ threadId: "visible" }] }],
      });
      expect(f.listPage).toHaveBeenCalledTimes(3);
    } finally {
      discovery.resolve({ nodes: [] });
      second.resolve(page([]));
      await advancing.done;
      operation.close();
      await Promise.allSettled(f.publications);
    }
  });

  it.each(["terminal-only", "offline"] as const)(
    "yields before the next local page after a completed %s node placeholder",
    async (route) => {
      const f = await fixture();
      const firstPage = createDeferred<CodexSessionCatalogPage>();
      const nodePublished = createDeferred<void>();
      const refillStarted = createDeferred<void>();
      f.listPage.mockImplementation(async (_home, params) => {
        if (params.cursor) {
          refillStarted.resolve();
          return page(["visible"]);
        }
        return firstPage.promise;
      });
      const operation = f.start({
        hostIds: undefined,
        listNodes: async () => ({
          nodes: [
            {
              nodeId: "remote",
              connected: route !== "offline",
              commands: [
                route === "offline"
                  ? CODEX_APP_SERVER_THREADS_LIST_COMMAND
                  : CODEX_TERMINAL_START_COMMAND,
              ],
              invocableCommands: [CODEX_TERMINAL_START_COMMAND],
            },
          ],
        }),
        onHost: (host) => {
          f.onHost(host);
          if (host.hostId === "node:remote") {
            nodePublished.resolve();
          }
        },
      });
      const advancing = observe(operation.next());
      try {
        await nodePublished.promise;
        await nextTurn();
        firstPage.resolve(page(["managed"], "next"));
        await expect(
          Promise.race([
            advancing.done.then(() => "yielded"),
            refillStarted.promise.then(() => "refilled"),
          ]),
        ).resolves.toBe("yielded");
        await expect(advancing.done).resolves.toEqual({
          status: "fulfilled",
          value: { done: false },
        });
        expect(f.listPage).toHaveBeenCalledOnce();
        await expect(operation.next()).resolves.toMatchObject({
          done: true,
          hosts: [
            { sessions: [{ threadId: "visible" }] },
            { hostId: "node:remote", connected: route !== "offline", sessions: [] },
          ],
        });
        expect(f.runtime.nodes.invoke).not.toHaveBeenCalled();
        if (route === "terminal-only") {
          expect(f.onHost).toHaveBeenCalledWith(
            expect.objectContaining({ canStartTerminal: true }),
          );
        }
      } finally {
        firstPage.resolve(page([]));
        await advancing.done;
        operation.close();
        await Promise.allSettled(f.publications);
      }
    },
  );

  it("keeps the filled operation inline after failed discovery", async () => {
    const f = await fixture();
    f.listPage.mockImplementation(async (_home, params) =>
      params.cursor ? page(["visible"]) : page(["managed"], "next"),
    );
    const listNodes = vi.fn(async () => {
      throw new Error("discovery unavailable");
    });
    const operation = f.start({ hostIds: undefined, listNodes });
    try {
      const result = await operation.next();
      expect(result.done).toBe(true);
      if (!result.done) {
        throw new Error("node selection was treated as an empty checkpoint");
      }
      expect(result.hosts[0]?.sessions.map((row) => row.threadId)).toEqual(["visible"]);
      expect(f.listPage).toHaveBeenCalledTimes(2);
      expect(listNodes).toHaveBeenCalledOnce();
      expect(result.hosts[1]?.hostId).toBe("node:registry");
    } finally {
      operation.close();
      await Promise.allSettled(f.publications);
    }
  });

  it.each(["resolve", "reject", "no waitUntil"] as const)(
    "keeps refill inline until a timed-out node's invocation and publication %s",
    async (outcome) => {
      const f = await fixture();
      vi.useFakeTimers();
      const first = createDeferred<CodexSessionCatalogPage>();
      const second = createDeferred<CodexSessionCatalogPage>();
      const third = createDeferred<CodexSessionCatalogPage>();
      const secondStarted = createDeferred<void>();
      const thirdStarted = createDeferred<void>();
      const invoked = createDeferred<void>();
      const invokeResult = createDeferred<unknown>();
      const published = createDeferred<void>();
      const publication = createDeferred<void>();
      const publicationError = new Error("node publication failed");
      vi.mocked(f.runtime.nodes.invoke).mockImplementation(() => {
        invoked.resolve();
        return invokeResult.promise;
      });
      f.listPage.mockImplementation(async (_home, params) => {
        if (params.cursor === "second") {
          secondStarted.resolve();
          return second.promise;
        }
        if (params.cursor === "third") {
          thirdStarted.resolve();
          return third.promise;
        }
        return params.cursor === "fourth" ? page(["visible"]) : first.promise;
      });
      const operation = f.start({
        hostIds: undefined,
        listNodes: async () => ({
          nodes: [
            {
              nodeId: "remote",
              connected: true,
              commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
            },
          ],
        }),
        // oxlint-disable-next-line typescript/no-misused-promises -- A JS publication promise remains owned after the fail-soft response.
        onHost: (host) => {
          if (host.hostId === "node:remote") {
            published.resolve();
            return publication.promise;
          }
          return undefined;
        },
        ...(outcome === "no waitUntil" ? { waitUntil: undefined } : {}),
      });
      const advancing = observe(operation.next());
      try {
        await invoked.promise;
        await vi.advanceTimersByTimeAsync(8_000);
        first.resolve(page(["managed"], "second"));
        await expect(
          Promise.race([
            secondStarted.promise.then(() => "refilled"),
            advancing.done.then(() => "settled"),
          ]),
        ).resolves.toBe("refilled");
        expect(advancing.state.settled).toBe(false);

        invokeResult.resolve({ payloadJSON: JSON.stringify(page([])) });
        await published.promise;
        second.resolve(page(["managed"], "third"));
        await expect(
          Promise.race([
            thirdStarted.promise.then(() => "refilled"),
            advancing.done.then(() => "settled"),
          ]),
        ).resolves.toBe("refilled");
        expect(advancing.state.settled).toBe(false);

        if (outcome === "reject") {
          publication.reject(publicationError);
        } else {
          publication.resolve();
        }
        await nextTurn();
        third.resolve(page(["managed"], "fourth"));
        await expect(advancing.done).resolves.toEqual({
          status: "fulfilled",
          value: { done: false },
        });
        expect(f.listPage).toHaveBeenCalledTimes(3);
        await expect(operation.next()).resolves.toMatchObject({
          done: true,
          hosts: [
            { sessions: [{ threadId: "visible" }] },
            { hostId: "node:remote", error: { code: "NODE_INVOKE_FAILED" } },
          ],
        });
        expect(f.runtime.nodes.invoke).toHaveBeenCalledOnce();
        const tails = await Promise.allSettled(f.publications);
        expect(tails.filter((tail) => tail.status === "rejected")).toEqual(
          outcome === "reject" ? [{ status: "rejected", reason: publicationError }] : [],
        );
      } finally {
        invokeResult.resolve({ payloadJSON: JSON.stringify(page([])) });
        publication.resolve();
        first.resolve(page([]));
        second.resolve(page([]));
        third.resolve(page([]));
        await advancing.done;
        operation.close();
        await Promise.allSettled(f.publications);
        vi.useRealTimers();
      }
    },
  );

  it("returns a complete local list at the node response deadline while its publication stays owned", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const invoked = createDeferred<void>();
    const invokeResult = createDeferred<unknown>();
    vi.mocked(f.runtime.nodes.invoke).mockImplementation(() => {
      invoked.resolve();
      return invokeResult.promise;
    });
    const operation = f.start({
      hostIds: undefined,
      listNodes: async () => ({
        nodes: [
          { nodeId: "remote", connected: true, commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND] },
        ],
      }),
    });
    const advancing = observe(operation.next());
    try {
      await invoked.promise;
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(advancing.done).resolves.toMatchObject({
        status: "fulfilled",
        value: {
          done: true,
          hosts: [
            { sessions: [{ threadId: "visible" }] },
            { hostId: "node:remote", error: { code: "NODE_INVOKE_FAILED" } },
          ],
        },
      });
      operation.close();
      expect(f.onHost.mock.calls.map(([host]) => host.hostId)).toEqual(["gateway:local"]);
      invokeResult.resolve({ payloadJSON: JSON.stringify(page(["late-node-row"])) });
      await Promise.all(f.publications);
      expect(f.onHost).toHaveBeenCalledWith(
        expect.objectContaining({
          hostId: "node:remote",
          sessions: [expect.objectContaining({ threadId: "late-node-row" })],
        }),
      );
      expect(f.listPage).toHaveBeenCalledOnce();
    } finally {
      invokeResult.resolve({ payloadJSON: JSON.stringify(page([])) });
      await advancing.done;
      operation.close();
      await Promise.allSettled(f.publications);
      vi.useRealTimers();
    }
  });

  it("joins a started node sibling before rejecting a fatal publication failure", async () => {
    const f = await fixture();
    const held = createDeferred<unknown>();
    const started = createDeferred<void>();
    vi.mocked(f.runtime.nodes.invoke).mockImplementation(() => {
      started.resolve();
      return held.promise;
    });
    const reason = new Error("offline node publication failed");
    const operation = f.start({
      hostIds: ["node:offline", "node:online"],
      listNodes: async () => ({
        nodes: [
          {
            nodeId: "offline",
            displayName: "A offline",
            connected: false,
            commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
          },
          {
            nodeId: "online",
            displayName: "B online",
            connected: true,
            commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
          },
        ],
      }),
      onHost: (host) => {
        if (host.nodeId === "offline") {
          throw reason;
        }
      },
    });
    const advancing = observe(operation.next());
    try {
      await started.promise;
      await nextTurn();
      expect.soft(advancing.state.settled).toBe(false);
      expect.soft(() => operation.close()).toThrow(/active/);
      held.resolve({ payloadJSON: JSON.stringify(page([])) });
      await expect(advancing.done).resolves.toEqual({ status: "rejected", reason });
      expect(f.runtime.nodes.invoke).toHaveBeenCalledOnce();
    } finally {
      held.resolve({ payloadJSON: JSON.stringify(page([])) });
      await advancing.done;
      operation.close();
      await Promise.allSettled(f.publications);
    }
  });

  it("disables intermediate handoff after a local page fails", async () => {
    const f = await fixture(2);
    const surviving = createDeferred<CodexSessionCatalogPage>();
    const survivorStarted = createDeferred<void>();
    f.listPage.mockImplementation(async (home, params) => {
      if (home === "home-0") {
        throw new Error("native page failed");
      }
      if (params.cursor) {
        return page(["survivor"]);
      }
      survivorStarted.resolve();
      return surviving.promise;
    });
    const operation = f.start();
    const advancing = observe(operation.next());
    try {
      await survivorStarted.promise;
      await nextTurn();
      surviving.resolve(page(["managed"], "next"));
      await expect(advancing.done).resolves.toMatchObject({
        status: "fulfilled",
        value: {
          done: true,
          hosts: [
            { error: { code: "APP_SERVER_UNAVAILABLE" } },
            { sessions: [{ threadId: "survivor" }] },
          ],
        },
      });
      expect(f.listPage).toHaveBeenCalledTimes(3);
    } finally {
      surviving.resolve(page([]));
      await advancing.done;
      operation.close();
      await Promise.allSettled(f.publications);
    }
  });
});
