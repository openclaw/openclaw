import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { expect, it, vi } from "vitest";
import { createResearchClient } from "../browser/client.js";

function fixture(retainStarts = true) {
  const connection = {
    connected: true,
    canRead: true,
    canWrite: true,
    canGrant: false,
    canAdmin: false,
    assistantAgentId: "main",
  };
  const subscriptions = new Set<() => void>();
  const events = new Map<string, () => void>();
  const requests: Array<{ action: string; params?: Record<string, unknown> }> = [];
  let selected: string | undefined;
  let list: unknown = {
    version: 1,
    sessionId: "generation-1",
    incarnation: "incarnation-1",
    jobs: [],
  };
  let start = async (_params?: Record<string, unknown>): Promise<unknown> => {
    throw new Error("Transport lost");
  };
  let read = async (params?: Record<string, unknown>): Promise<unknown> => ({
    sessionId: "generation-1",
    incarnation: "incarnation-1",
    job: { jobId: params?.jobId },
  });
  // SAFETY: This view only consumes the five host capabilities below; no renderer is mocked here.
  const host = {
    connection,
    request: async (method: string, params?: Record<string, unknown>) => {
      const action = method.split(".").at(-1)!;
      requests.push({ action, params });
      if (action === "start") {
        return start(params);
      }
      if (action === "list") {
        return list;
      }
      if (action === "read") {
        return read(params);
      }
      return {
        sessionId: "generation-1",
        incarnation: "incarnation-1",
        job: { jobId: params?.jobId },
      };
    },
    onEvent: (name: string, listener: () => void) => {
      events.set(name, listener);
      return () => events.delete(name);
    },
    subscribe: (listener: () => void) => {
      subscriptions.add(listener);
      return () => subscriptions.delete(listener);
    },
  } as unknown as ControlUiHost;
  const signal = new AbortController();
  const client = createResearchClient(
    host,
    { sessionKey: "agent:main:test", agentId: "main" },
    signal.signal,
    () => selected,
    (id) => {
      selected = id;
    },
    retainStarts,
  );
  return {
    client,
    signal,
    connection,
    requests,
    events,
    notify: () => subscriptions.forEach((listener) => listener()),
    setList(value: unknown) {
      list = value;
    },
    setRead(value: typeof read) {
      read = value;
    },
    setStart(value: typeof start) {
      start = value;
    },
  };
}
it("reuses the exact idempotency key after an uncertain response, suppresses double clicks and does not start on reconnect", async () => {
  const f = fixture();
  try {
    await f.client.refresh();
    await f.client.mutate("start", "Research a tree");
    const pending = f.client.pending();
    expect(pending?.question).toBe("Research a tree");
    const gate = Promise.withResolvers<unknown>();
    f.setStart(async () => gate.promise);
    const retry = f.client.mutate("start", "Research a tree");
    await f.client.mutate("start", "Research a tree");
    expect(f.requests.filter((item) => item.action === "start")).toHaveLength(2);
    const starts = f.requests.filter((item) => item.action === "start");
    expect(starts[0]?.params?.idempotencyKey).toBe(starts[1]?.params?.idempotencyKey);
    expect(starts.map((item) => item.params?.incarnation)).toEqual([
      "incarnation-1",
      "incarnation-1",
    ]);
    f.connection.connected = false;
    f.notify();
    gate.resolve({
      sessionId: "generation-1",
      incarnation: "incarnation-1",
      job: { jobId: "accepted" },
    });
    await retry;
    expect(f.client.read().offline).toBe(true);
    expect(f.client.pending()?.key).toBe(pending?.key);
    f.connection.connected = true;
    f.notify();
    await vi.waitFor(() => expect(f.client.read().offline).toBe(false));
    expect(f.requests.filter((item) => item.action === "start")).toHaveLength(2);
  } finally {
    f.client.dispose();
  }
});
it("drops a response after view retirement and clears retained private state after access loss", async () => {
  const f = fixture();
  try {
    f.setList({
      version: 1,
      sessionId: "generation-1",
      incarnation: "incarnation-1",
      jobs: [{ jobId: "one", title: "Private question" }],
    });
    await f.client.refresh();
    expect(f.client.read().jobs).toHaveLength(1);
    f.connection.canRead = false;
    f.notify();
    expect(f.client.read().jobs).toEqual([]);
    expect(f.client.read().job).toBeUndefined();
    expect(f.client.read().sessionId).toBeUndefined();
    f.connection.canRead = true;
    const gate = Promise.withResolvers<unknown>();
    f.setList(gate.promise);
    const refresh = f.client.refresh();
    f.signal.abort();
    f.client.dispose();
    gate.resolve({
      version: 1,
      sessionId: "generation-1",
      incarnation: "incarnation-1",
      jobs: [{ jobId: "late" }],
    });
    await refresh;
    expect(f.client.read().jobs).toEqual([]);
  } finally {
    f.client.dispose();
  }
});
it("clears retry authority on a different admitted incarnation", async () => {
  const f = fixture();
  try {
    await f.client.refresh();
    await f.client.mutate("start", "Original question");
    expect(f.client.pending()).toBeDefined();
    f.setList({ version: 1, sessionId: "generation-1", incarnation: "incarnation-2", jobs: [] });
    await f.client.refresh();
    expect(f.client.pending()).toBeUndefined();
    expect(f.client.read().incarnation).toBe("incarnation-2");
  } finally {
    f.client.dispose();
  }
});

it("quarantines an uncertain retry across transient read errors without losing its key", async () => {
  const f = fixture();
  try {
    await f.client.refresh();
    await f.client.mutate("start", "Original question");
    const key = f.client.pending()!.key;
    f.setList(
      Promise.reject(Object.assign(new Error("Service starting"), { code: "UNAVAILABLE" })),
    );
    await f.client.refresh();
    expect(f.client.read().sessionId).toBeUndefined();
    expect(f.client.pending()).toBeUndefined();
    f.setList({ version: 1, sessionId: "generation-1", incarnation: "incarnation-1", jobs: [] });
    await f.client.refresh();
    expect(f.client.pending()?.key).toBe(key);
    await f.client.mutate("start", "Original question");
    expect(
      f.requests
        .filter((request) => request.action === "start")
        .map((request) => request.params?.idempotencyKey),
    ).toEqual([key, key]);
  } finally {
    f.client.dispose();
  }
});
it("unlocks a definitively rejected start and accepts acknowledgement despite concurrent refresh", async () => {
  const f = fixture();
  try {
    await f.client.refresh();
    f.setStart(async () => {
      throw Object.assign(new Error("No work was accepted"), {
        details: { code: "RESEARCH_START_REJECTED" },
      });
    });
    await f.client.mutate("start", "First question");
    expect(f.client.pending()).toBeUndefined();
    expect(f.client.read().actionError).toBe("No work was accepted");
    const gate = Promise.withResolvers<unknown>();
    f.setStart(async () => gate.promise);
    const start = f.client.mutate("start", "Second question");
    expect(f.client.read().pending?.question).toBe("Second question");
    await f.client.refresh();
    gate.resolve({
      sessionId: "generation-1",
      incarnation: "incarnation-1",
      job: { jobId: "accepted" },
    });
    await start;
    expect(f.client.pending()).toBeUndefined();
    expect(f.client.read().pending).toBeUndefined();
  } finally {
    f.client.dispose();
  }
});

it("mints retry keys without secure-context-only UUID and reports unavailable randomness", async () => {
  const f = fixture();
  const uuid = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    throw new Error("Unavailable on HTTP");
  });
  try {
    await f.client.refresh();
    await f.client.mutate("start", "HTTP research");
    expect(f.client.pending()?.key).toMatch(/^[0-9a-f]{32}$/);
    expect(uuid).not.toHaveBeenCalled();
  } finally {
    uuid.mockRestore();
    f.client.dispose();
  }
  const failed = fixture();
  const random = vi.spyOn(crypto, "getRandomValues").mockImplementation(() => {
    throw new Error("Randomness disabled");
  });
  try {
    await failed.client.refresh();
    await failed.client.mutate("start", "No randomness");
    expect(failed.client.read().actionError).toContain("No work was started");
    expect(failed.requests.some((request) => request.action === "start")).toBe(false);
  } finally {
    random.mockRestore();
    failed.client.dispose();
  }
});
it("keeps header observers out of the form's retained retry storage", async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  const pane = fixture();
  const header = fixture(false);
  try {
    await pane.client.refresh();
    await pane.client.mutate("start", "Retained only by the form");
    const saved = [...values.values()];
    await header.client.refresh();
    expect(header.client.pending()).toBeUndefined();
    header.connection.canRead = false;
    header.notify();
    expect([...values.values()]).toEqual(saved);
  } finally {
    pane.client.dispose();
    header.client.dispose();
    vi.unstubAllGlobals();
  }
});

it("never targets an undisplayed job during a list-to-read selection change", async () => {
  const f = fixture();
  const list = (jobId: string) => ({
    version: 1,
    sessionId: "generation-1",
    incarnation: "incarnation-1",
    jobs: [{ jobId, state: "running" }],
  });
  try {
    f.setList(list("shown"));
    await f.client.refresh();
    expect(f.client.read().job?.jobId).toBe("shown");
    const gate = Promise.withResolvers<unknown>();
    f.setRead(async () => gate.promise);
    f.setList(list("new"));
    const refresh = f.client.refresh();
    await vi.waitFor(() => expect(f.client.read().selected).toBe("new"));
    expect(f.client.read().job).toBeUndefined();
    await f.client.mutate("cancel");
    expect(f.requests.some((request) => request.action === "cancel")).toBe(false);
    gate.resolve({
      sessionId: "generation-1",
      incarnation: "incarnation-1",
      job: { jobId: "new" },
    });
    await refresh;
    await f.client.mutate("cancel");
    expect(f.requests.find((request) => request.action === "cancel")?.params).toMatchObject({
      incarnation: "incarnation-1",
      jobId: "new",
    });
  } finally {
    f.client.dispose();
  }
});
