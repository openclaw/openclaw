import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { patchSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLazyCodexAppServerBindingStore } from "./session-binding-store.js";
import {
  bindingStoreKey,
  createCodexAppServerBindingStore,
  resolveCodexSessionBinding,
} from "./session-binding.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";

afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests();
});

describe("Codex app-server binding reads", () => {
  it.each([
    { name: "eager", create: createCodexAppServerBindingStore },
    { name: "lazy", create: createLazyCodexAppServerBindingStore },
  ])(
    "keeps ordered failures and never retries failed bulk acquisition in the $name facade",
    ({ create }) => {
      const state = createCodexTestBindingStateStore();
      const readValue = state.lookup.bind(state);
      const lookup = vi.spyOn(state, "lookup");
      const lookupMany = vi.fn((keys: readonly string[]) =>
        keys.map((key) => ({ ok: true as const, value: readValue(key) })),
      );
      const store = create({ ...state, lookupMany });
      const first = { kind: "conversation" as const, bindingId: "first" };
      const invalid = { kind: "conversation" as const, bindingId: " " };
      state.register(bindingStoreKey(first), {
        version: 1,
        state: "active",
        binding: { threadId: "", cwd: "/repo" },
      });
      expect(() => [...store.readMany!([first, invalid])]).toThrow(
        "Invalid Codex app-server binding row: conversation:first",
      );
      expect(lookupMany).not.toHaveBeenCalled();
      state.delete(bindingStoreKey(first));
      expect(() => [...store.readMany!([first, invalid])]).toThrow(
        "Codex app-server conversation binding requires a binding id",
      );
      lookup.mockClear();
      const failure = new Error("bulk database unavailable");
      lookupMany.mockImplementation(() => {
        throw failure;
      });
      expect(() => [...store.readMany!([first, { ...first, bindingId: "second" }])]).toThrow(
        failure,
      );
      expect(lookupMany).toHaveBeenCalledOnce();
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it("keeps all rows readable when the host lacks bulk reads or the cohort exceeds its limit", () => {
    const state = createCodexTestBindingStateStore();
    const first = { kind: "conversation" as const, bindingId: "first" };
    const last = { kind: "conversation" as const, bindingId: "last" };
    const binding = { threadId: "owned", cwd: "/repo" };
    state.register(bindingStoreKey(last), { version: 1, state: "active", binding });
    const legacy = createLazyCodexAppServerBindingStore(state);
    expect(legacy.readMany).toBeUndefined();
    expect([legacy.read(first), legacy.read(last)]).toEqual([undefined, binding]);
    const lookupMany = vi.fn(() => {
      throw new Error("host bulk limit exceeded");
    });
    const store = createLazyCodexAppServerBindingStore({ ...state, lookupMany });
    const identities = [...Array.from({ length: 10_000 }, () => first), last];
    const result = [...store.readMany!(identities)];
    expect(result).toHaveLength(identities.length);
    expect(result.slice(0, -1).every((value) => value === undefined)).toBe(true);
    expect(result.at(-1)).toEqual(binding);
    expect(lookupMany).not.toHaveBeenCalled();
  });

  it("fences an already-readable binding when its admitted session generation rotates", async () => {
    const fixture = await createOpenClawTestState({
      prefix: "codex-readable-authority-",
      layout: "state-only",
      applyEnv: false,
    });
    const root = fixture.stateDir;
    const storePath = path.join(root, "sessions.json");
    const state = createCodexTestBindingStateStore();
    const store = createCodexAppServerBindingStore(state);
    const current = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
      sessionKey: "agent:main:readable",
    };
    const scope = { agentId: current.agentId, sessionKey: current.sessionKey, storePath };
    const binding = { threadId: "thread-current", cwd: "/repo" };
    try {
      await upsertSessionEntry({
        ...scope,
        entry: { sessionId: current.sessionId, updatedAt: 1 },
      });
      await store.mutate(current, { kind: "set", binding });

      const resolved = await resolveCodexSessionBinding({
        bindingStore: store,
        identity: current,
        storePath,
      });
      expect(resolved.binding).toEqual(binding);

      await patchSessionEntry({
        ...scope,
        update: () => ({ sessionId: "session-successor" }),
      });
      expect(resolved.assertCurrent).toThrow("Codex session generation is no longer current");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects an already-readable binding owned by a stale admitted session", async () => {
    const fixture = await createOpenClawTestState({
      prefix: "codex-readable-stale-",
      layout: "state-only",
      applyEnv: false,
    });
    const root = fixture.stateDir;
    const storePath = path.join(root, "sessions.json");
    const state = createCodexTestBindingStateStore();
    const store = createCodexAppServerBindingStore(state);
    const stale = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-stale",
      sessionKey: "agent:main:readable",
    };
    try {
      await upsertSessionEntry({
        agentId: stale.agentId,
        sessionKey: stale.sessionKey,
        storePath,
        entry: { sessionId: "session-current", updatedAt: 1 },
      });
      await store.mutate(stale, {
        kind: "set",
        binding: { threadId: "thread-stale", cwd: "/repo" },
      });

      await expect(
        resolveCodexSessionBinding({ bindingStore: store, identity: stale, storePath }),
      ).rejects.toThrow("Codex session generation is no longer current");
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves caller authority for a scoped session with no durable row", async () => {
    const fixture = await createOpenClawTestState({
      prefix: "codex-readable-ephemeral-",
      layout: "state-only",
      applyEnv: false,
    });
    const root = fixture.stateDir;
    const storePath = path.join(root, "sessions.json");
    const state = createCodexTestBindingStateStore();
    const store = createCodexAppServerBindingStore(state);
    const ephemeral = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-ephemeral",
      sessionKey: "agent:main:ephemeral",
    };
    let active = true;
    try {
      await upsertSessionEntry({
        agentId: ephemeral.agentId,
        sessionKey: "agent:main:other",
        storePath,
        entry: { sessionId: "session-other", updatedAt: 1 },
      });
      const binding = { threadId: "thread-ephemeral", cwd: "/repo" };
      await store.mutate(ephemeral, { kind: "set", binding });

      const resolved = await resolveCodexSessionBinding({
        bindingStore: store,
        identity: ephemeral,
        storePath,
        assertCurrent: () => {
          if (!active) {
            throw new Error("caller authority closed");
          }
        },
      });
      expect(resolved.binding).toEqual(binding);
      expect(resolved.assertCurrent).not.toThrow();

      active = false;
      expect(resolved.assertCurrent).toThrow("caller authority closed");
    } finally {
      await fixture.cleanup();
    }
  });
});
