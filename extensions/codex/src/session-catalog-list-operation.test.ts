import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { CODEX_CATALOG_HOST_RESPONSE_TIMEOUT_MS } from "./session-catalog-limits.js";
import {
  fixture,
  nodeFixture,
  observe,
  page,
} from "./session-catalog-list-operation.test-support.js";
import { CODEX_APP_SERVER_THREADS_LIST_COMMAND } from "./session-catalog-parsing.js";
import { CODEX_TERMINAL_START_COMMAND } from "./session-catalog-terminal.js";
import type { CodexSessionCatalogPage } from "./session-catalog-types.js";

const fulfilled = <T>(value: T) => ({ status: "fulfilled", value });
const failedHost = (code: string) => ({ error: { code } });
const payload = (ids: string[] = []) => ({ payloadJSON: JSON.stringify(page(ids)) });
const nodeAnswer = (threadId: string) =>
  expect.objectContaining({
    hostId: "node:remote",
    sessions: [expect.objectContaining({ threadId })],
  });
function heldCall<T>() {
  const held = createDeferred<T>();
  const started = createDeferred<void>();
  return {
    ...held,
    started: started.promise,
    call: () => {
      started.resolve();
      return held.promise;
    },
  };
}
async function finish(
  f: Awaited<ReturnType<typeof fixture>>,
  operation: ReturnType<typeof f.start>,
  pending?: Promise<unknown>,
) {
  if (pending) {
    await pending;
  }
  operation.close();
  await Promise.allSettled(f.publications);
}
async function expectHosts(pending: Promise<unknown>, hosts: unknown[]) {
  await expect(pending).resolves.toMatchObject(fulfilled({ done: true, hosts }));
}
const catalogNode = (nodeId = "remote", connected = true, displayName?: string) => ({
  nodeId,
  connected,
  ...(displayName ? { displayName } : {}),
  commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
});
const adoption = vi.hoisted(() => ({
  hold: undefined as { promise: Promise<Map<string, never>>; started: () => void } | undefined,
}));

vi.mock("./session-catalog-adoption.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-catalog-adoption.js")>();
  return {
    ...actual,
    listAdoptedSessionEntries: vi.fn(
      (params: Parameters<typeof actual.listAdoptedSessionEntries>[0]) => {
        const held = adoption.hold;
        adoption.hold = undefined;
        held?.started();
        return held?.promise ?? actual.listAdoptedSessionEntries(params);
      },
    ),
  };
});

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
    assert(result.done, "filled result missing");
    expect(result.hosts[0]).toMatchObject({
      sessions: [{ threadId: "keep-one" }, { threadId: "keep-two" }],
      nextCursor: "remaining",
    });
    expect(f.listPage.mock.calls[1]).toEqual([
      "home-0",
      { limit: 1, cursor: "next", searchTerm: "keep" },
    ]);
    await Promise.all(f.publications);
    expect(f.onHost).toHaveBeenCalledExactlyOnceWith(result.hosts[0]);
  } finally {
    await finish(f, operation);
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
    await finish(f, operation);
  }
});

it("joins a held control page after active abort before allowing closure", async () => {
  const f = await fixture();
  const held = heldCall<CodexSessionCatalogPage>();
  f.listPage.mockImplementation(held.call);
  const operation = f.start();
  const advancing = observe(operation.next());
  try {
    await held.started;
    f.controller.abort(new Error("catalog retired"));
    await nextTurn();
    expect(advancing.state.settled).toBe(false);
    held.resolve(page(["managed"], "next"));
    await expectHosts(advancing.done, [failedHost("APP_SERVER_UNAVAILABLE")]);
    operation.close();
    expect(f.listPage).toHaveBeenCalledOnce();
  } finally {
    held.resolve(page([]));
    await finish(f, operation, advancing.done);
  }
});

it("yields before the next local page after a completed terminal-only node placeholder", async () => {
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
          connected: true,
          commands: [CODEX_TERMINAL_START_COMMAND],
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
    await expect(advancing.done).resolves.toEqual(fulfilled({ done: false }));
    expect(f.listPage).toHaveBeenCalledOnce();
    await expect(operation.next()).resolves.toMatchObject({
      done: true,
      hosts: [
        { sessions: [{ threadId: "visible" }] },
        { hostId: "node:remote", connected: true, sessions: [] },
      ],
    });
    expect(f.runtime.nodes.invoke).not.toHaveBeenCalled();
    expect(f.onHost).toHaveBeenCalledWith(expect.objectContaining({ canStartTerminal: true }));
  } finally {
    firstPage.resolve(page([]));
    await finish(f, operation, advancing.done);
  }
});

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
    assert(result.done, "node selection was treated as an empty checkpoint");
    expect(result.hosts[0]?.sessions.map((row) => row.threadId)).toEqual(["visible"]);
    expect(f.listPage).toHaveBeenCalledTimes(2);
    expect(listNodes).toHaveBeenCalledOnce();
    expect(result.hosts[1]).toMatchObject({
      hostId: "node:registry",
      error: {
        code: "NODE_LIST_FAILED",
        message: "Paired nodes could not be listed: discovery unavailable",
      },
    });
  } finally {
    await finish(f, operation);
  }
});

it.each(["reject", "no waitUntil"] as const)(
  "settles timed-out local work while a node publication can still %s",
  async (outcome) => {
    const f = await fixture();
    vi.useFakeTimers();
    const first = createDeferred<CodexSessionCatalogPage>();
    const invokeResult = heldCall<unknown>();
    const published = createDeferred<void>();
    const publication = createDeferred<void>();
    const publicationError = new Error("node publication failed");
    vi.mocked(f.runtime.nodes.invoke).mockImplementation(invokeResult.call);
    f.listPage.mockImplementation(async () => first.promise);
    const operation = f.start({
      hostIds: undefined,
      listNodes: async () => ({ nodes: [catalogNode()] }),
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
      await invokeResult.started;
      await vi.advanceTimersByTimeAsync(CODEX_CATALOG_HOST_RESPONSE_TIMEOUT_MS);
      expect(advancing.state.settled).toBe(true);
      await expectHosts(advancing.done, [
        failedHost("APP_SERVER_UNAVAILABLE"),
        { hostId: "node:remote", ...failedHost("NODE_INVOKE_FAILED") },
      ]);
      operation.close();
      first.resolve(page(["managed"], "second"));
      invokeResult.resolve(payload());
      await published.promise;
      const tails = observe(Promise.allSettled(f.publications));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.listPage).toHaveBeenCalledOnce();
      expect(f.runtime.nodes.invoke).toHaveBeenCalledOnce();
      if (outcome === "reject") {
        expect(tails.state.settled).toBe(false);
        publication.reject(publicationError);
      } else {
        publication.resolve();
      }
      await expect(tails.done).resolves.toMatchObject({ status: "fulfilled" });
      const results = await Promise.allSettled(f.publications);
      expect(results.filter((tail) => tail.status === "rejected")).toEqual(
        outcome === "reject" ? [{ status: "rejected", reason: publicationError }] : [],
      );
    } finally {
      invokeResult.resolve(payload());
      publication.resolve();
      first.resolve(page([]));
      await finish(f, operation, advancing.done);
      vi.useRealTimers();
    }
  },
);

it("delivers each cold query when the newer query publishes first", async () => {
  const f = await nodeFixture();
  const older = createDeferred<unknown>();
  const newer = createDeferred<unknown>();
  f.invoke.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const firstHost = vi.fn();
  const secondHost = vi.fn();
  vi.useFakeTimers();
  const first = observe(f.read({ onHost: firstHost }));
  const second = observe(f.read({ onHost: secondHost, limitPerHost: 2 }));
  try {
    await nextTurn();
    await vi.advanceTimersByTimeAsync(250);
    expect([first.state.settled, second.state.settled]).toEqual([true, true]);
    newer.resolve(payload(["newer-answer"]));
    await nextTurn();
    older.resolve(payload(["first-answer"]));
    await nextTurn();
    expect(firstHost).toHaveBeenCalledWith(nodeAnswer("first-answer"));
    await Promise.all(f.publications);
    expect(secondHost).toHaveBeenCalledWith(nodeAnswer("newer-answer"));
  } finally {
    older.resolve(payload());
    newer.resolve(payload());
    await Promise.allSettled([first.done, second.done, ...f.publications]);
    vi.useRealTimers();
  }
});

it("invalidates delayed node publications after abort", async () => {
  const f = await nodeFixture();
  await f.read();
  const old = createDeferred<unknown>();
  f.invoke.mockReturnValueOnce(old.promise);
  await f.read();
  f.controller.abort();
  const held = createDeferred<unknown>();
  f.invoke.mockReturnValueOnce(held.promise);
  vi.useFakeTimers();
  const pending = observe(f.read({ signal: new AbortController().signal }));
  try {
    await nextTurn();
    await vi.advanceTimersByTimeAsync(250);
    old.resolve(payload(["obsolete"]));
    await nextTurn();
    expect(pending.state.settled).toBe(true);
    expect(
      f.onHost.mock.calls.flatMap(([host]) =>
        host.sessions.map((row: { threadId: string }) => row.threadId),
      ),
    ).not.toContain("obsolete");
    await expect(pending.done).resolves.toMatchObject({ status: "fulfilled" });
  } finally {
    old.resolve(payload());
    held.resolve(payload());
    await pending.done;
    await Promise.allSettled(f.publications);
    vi.useRealTimers();
  }
});

it("joins a started node sibling before rejecting a fatal publication failure", async () => {
  const f = await fixture();
  const held = heldCall<unknown>();
  vi.mocked(f.runtime.nodes.invoke).mockImplementation(held.call);
  const reason = new Error("offline node publication failed");
  const operation = f.start({
    hostIds: ["node:offline", "node:online"],
    listNodes: async () => ({
      nodes: [catalogNode("offline", false, "A offline"), catalogNode("online", true, "B online")],
    }),
    onHost: (host) => {
      if (host.nodeId === "offline") {
        throw reason;
      }
    },
  });
  const advancing = observe(operation.next());
  try {
    await held.started;
    await nextTurn();
    expect.soft(advancing.state.settled).toBe(false);
    expect.soft(() => operation.close()).toThrow(/active/);
    held.resolve(payload());
    await expect(advancing.done).resolves.toEqual({ status: "rejected", reason });
    expect(f.runtime.nodes.invoke).toHaveBeenCalledOnce();
  } finally {
    held.resolve(payload());
    await finish(f, operation, advancing.done);
  }
});

it("disables intermediate handoff after a local page fails", async () => {
  const f = await fixture(2);
  const surviving = heldCall<CodexSessionCatalogPage>();
  f.listPage.mockImplementation(async (home, params) => {
    if (home === "home-0") {
      throw new Error("native page failed");
    }
    if (params.cursor) {
      return page(["survivor"]);
    }
    return surviving.call();
  });
  const operation = f.start();
  const advancing = observe(operation.next());
  try {
    await surviving.started;
    await nextTurn();
    surviving.resolve(page(["managed"], "next"));
    await expectHosts(advancing.done, [
      failedHost("APP_SERVER_UNAVAILABLE"),
      { sessions: [{ threadId: "survivor" }] },
    ]);
    expect(f.listPage).toHaveBeenCalledTimes(3);
  } finally {
    surviving.resolve(page([]));
    await finish(f, operation, advancing.done);
  }
});

it.each([
  { phase: "page", progressive: false },
  { phase: "page", progressive: true },
  { phase: "adoption", progressive: false },
  { phase: "adoption", progressive: true },
])("isolates a stalled $phase with progressive=$progressive", async ({ phase, progressive }) => {
  const f = await fixture(2);
  vi.useFakeTimers();
  const started = createDeferred<void>();
  const heldPage = createDeferred<CodexSessionCatalogPage>();
  const heldAdoption = createDeferred<Map<string, never>>();
  if (phase === "adoption") {
    adoption.hold = { promise: heldAdoption.promise, started: started.resolve };
  }
  f.listPage.mockImplementation(async (home) => {
    if (home !== "home-0") {
      if (phase === "adoption") {
        await started.promise;
      }
      return page(["survivor"]);
    }
    if (phase === "page") {
      started.resolve();
      return heldPage.promise;
    }
    return page(["stalled"]);
  });
  const operation = f.start({ allowPartialResults: progressive });
  const advancing = observe(operation.next());
  try {
    await started.promise;
    if (progressive) {
      await vi.advanceTimersByTimeAsync(250);
      await expectHosts(advancing.done, [
        { pending: true },
        { sessions: [{ threadId: "survivor" }] },
      ]);
      operation.close();
    }
    await vi.advanceTimersByTimeAsync(CODEX_CATALOG_HOST_RESPONSE_TIMEOUT_MS);
    if (!progressive) {
      await expectHosts(advancing.done, [
        failedHost("APP_SERVER_UNAVAILABLE"),
        { sessions: [{ threadId: "survivor" }] },
      ]);
    }
    await Promise.all(f.publications);
    expect(f.onHost).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: f.homes[0]!.hostId,
        connected: false,
        sessions: [],
        error: expect.objectContaining({ code: "APP_SERVER_UNAVAILABLE" }),
      }),
    );
    heldPage.resolve(page(["late"]));
    heldAdoption.resolve(new Map<string, never>());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onHost.mock.calls.filter(([host]) => host.hostId === f.homes[0]!.hostId)).toHaveLength(
      1,
    );
  } finally {
    adoption.hold = undefined;
    heldPage.resolve(page([]));
    heldAdoption.resolve(new Map<string, never>());
    await finish(f, operation, advancing.done);
    vi.useRealTimers();
  }
});
