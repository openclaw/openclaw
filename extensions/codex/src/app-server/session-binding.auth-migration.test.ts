import { describe, expect, it, vi } from "vitest";
import {
  bindingStoreKey,
  createCodexAppServerBindingStore,
  createCodexTestBindingStateStore,
  type StoredCodexAppServerBinding,
} from "./session-binding.test-helpers.js";

const identity = {
  kind: "session" as const,
  agentId: "main",
  sessionKey: "agent:main:test",
  sessionId: "session-1",
};
const mutation = {
  kind: "clear-auth-profile" as const,
  threadId: "thread-1",
  clientId: "client-1",
  expectedAuthProfileId: "openai:retired",
  dryRun: false,
};

function fixture() {
  const original: StoredCodexAppServerBinding = {
    version: 1,
    state: "active",
    sessionId: identity.sessionId,
    binding: {
      threadId: "thread-1",
      cwd: "/workspace",
      clientId: "client-1",
      authProfileId: "openai:retired",
      rolloutPath: "/retained/history",
      historyCoveredThrough: "2026-01-01T00:00:00.000Z",
    },
    nativeSubagentTaskImport: { retained: true },
  };
  const key = bindingStoreKey(identity);
  const values = new Map([[key, structuredClone(original)]]);
  const state = createCodexTestBindingStateStore(values);
  return { original, key, values, state, store: createCodexAppServerBindingStore(state) };
}

describe("explicit retired auth profile migration", () => {
  it("dry-runs without writes and clears only the pin while retaining thread and history metadata", async () => {
    const { store, values, key, original } = fixture();
    expect(await store.mutate(identity, { ...mutation, dryRun: true })).toBe(true);
    expect(values.get(key)).toEqual(original);
    expect(await store.mutate(identity, mutation)).toBe(true);
    const expected = structuredClone(original);
    if (expected.state === "active") {
      delete expected.binding.authProfileId;
    }
    expect(values.get(key)).toEqual(expected);
    expect(await store.mutate(identity, mutation)).toBe(true);
    expect(values.get(key)).toEqual(expected);
  });

  it.each(["generation", "thread", "client", "profile", "children", "submissions", "supervision"])(
    "refuses changed %s ownership",
    async (change) => {
      const { store, values, key, original } = fixture();
      const row = values.get(key)!;
      if (row.state !== "active") {
        throw new Error("fixture");
      }
      if (change === "generation") {
        row.sessionId = "session-2";
      }
      if (change === "thread") {
        row.binding.threadId = "thread-2";
      }
      if (change === "client") {
        row.binding.clientId = "client-2";
      }
      if (change === "profile") {
        row.binding.authProfileId = "openai:new";
      }
      if (change === "children") {
        row.nativeSubagentAssignments = [];
      }
      if (change === "submissions") {
        row.nativeSubagentSubmissions = [];
      }
      if (change === "supervision") {
        Object.assign(row.binding, {
          connectionScope: "supervision",
          supervisionSourceThreadId: "native-source",
          preserveNativeModel: true,
          conversationSourceTransferComplete: true,
          model: "native-model",
          modelProvider: "openai",
        });
      }
      const expected = structuredClone(row);
      expect(await store.mutate(identity, mutation)).toBe(false);
      expect(values.get(key)).toEqual(expected);
      expect(values.get(key)).not.toEqual(original);
    },
  );

  it("refuses a lease that remains active throughout acquisition", async () => {
    vi.useFakeTimers();
    try {
      const { store, values, key } = fixture();
      values.get(key)!.lease = { token: "active-run", expiresAt: Date.now() + 120_000 };
      const expected = structuredClone(values.get(key));
      const refused = expect(store.mutate(identity, mutation)).rejects.toThrow(
        "Timed out waiting for Codex binding lease",
      );
      await vi.advanceTimersByTimeAsync(71_000);
      await refused;
      expect(values.get(key)).toEqual(expected);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rechecks the exact profile when the owner CAS retries", async () => {
    const { store, state, values, key } = fixture();
    const withCurrent = state.withCurrent!.bind(state);
    let raced = false;
    state.withCurrent = (authority) => {
      const scoped = withCurrent(authority);
      return {
        ...scoped,
        async compareAndApply(...args) {
          if (!raced) {
            raced = true;
            const row = values.get(key)!;
            if (row.state === "active") {
              row.binding.authProfileId = "openai:new";
            }
          }
          return scoped.compareAndApply(...args);
        },
      };
    };
    expect(await store.mutate(identity, mutation)).toBe(false);
    expect((await store.readAsync(identity))?.authProfileId).toBe("openai:new");
  });
});
