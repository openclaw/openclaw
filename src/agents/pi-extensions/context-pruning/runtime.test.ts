import { describe, expect, it } from "vitest";
import type { EffectiveContextPruningSettings } from "./settings.js";
import {
  setContextPruningRuntime,
  getContextPruningRuntime,
  type ContextPruningRuntimeValue,
} from "./runtime.js";

function makeSettings(): EffectiveContextPruningSettings {
  return {
    mode: "cache-ttl",
    ttlMs: 300_000,
    softTrimRatio: 0.7,
    hardClearRatio: 0.9,
    keepLastAssistants: 3,
    minPrunableToolChars: 0,
    softTrim: { maxChars: 4000, headChars: 500, tailChars: 500 },
    hardClear: { enabled: true, placeholder: "[pruned]" },
    tools: { prunable: [], protected: [] },
  };
}

describe("ContextPruningRuntime", () => {
  it("stores and retrieves runtime value by session manager identity", () => {
    const sm = {};
    const value: ContextPruningRuntimeValue = {
      settings: makeSettings(),
      isToolPrunable: () => true,
    };
    setContextPruningRuntime(sm, value);
    expect(getContextPruningRuntime(sm)).toBe(value);
  });

  it("returns null when no runtime is set", () => {
    expect(getContextPruningRuntime({})).toBeNull();
  });

  it("deletes runtime when set to null", () => {
    const sm = {};
    setContextPruningRuntime(sm, {
      settings: makeSettings(),
      isToolPrunable: () => true,
    });
    expect(getContextPruningRuntime(sm)).not.toBeNull();
    setContextPruningRuntime(sm, null);
    expect(getContextPruningRuntime(sm)).toBeNull();
  });

  it("ignores non-object session managers", () => {
    setContextPruningRuntime(null, { settings: makeSettings(), isToolPrunable: () => true });
    expect(getContextPruningRuntime(null)).toBeNull();

    setContextPruningRuntime(undefined, { settings: makeSettings(), isToolPrunable: () => true });
    expect(getContextPruningRuntime(undefined)).toBeNull();

    setContextPruningRuntime("string" as any, {
      settings: makeSettings(),
      isToolPrunable: () => true,
    });
    expect(getContextPruningRuntime("string" as any)).toBeNull();
  });

  it("stores sessionKey in runtime value", () => {
    const sm = {};
    const value: ContextPruningRuntimeValue = {
      settings: makeSettings(),
      isToolPrunable: () => true,
      sessionKey: "agent:main:slack:channel:C123",
    };
    setContextPruningRuntime(sm, value);
    expect(getContextPruningRuntime(sm)?.sessionKey).toBe("agent:main:slack:channel:C123");
  });

  it("stores storePath in runtime value", () => {
    const sm = {};
    const value: ContextPruningRuntimeValue = {
      settings: makeSettings(),
      isToolPrunable: () => true,
      storePath: "/home/user/.openclaw/agents/main/sessions/sessions.json",
    };
    setContextPruningRuntime(sm, value);
    expect(getContextPruningRuntime(sm)?.storePath).toBe(
      "/home/user/.openclaw/agents/main/sessions/sessions.json",
    );
  });

  it("stores both sessionKey and storePath together", () => {
    const sm = {};
    const value: ContextPruningRuntimeValue = {
      settings: makeSettings(),
      isToolPrunable: () => true,
      sessionKey: "test-key",
      storePath: "/tmp/sessions.json",
      contextWindowTokens: 200_000,
      lastCacheTouchAt: Date.now(),
    };
    setContextPruningRuntime(sm, value);
    const retrieved = getContextPruningRuntime(sm);
    expect(retrieved?.sessionKey).toBe("test-key");
    expect(retrieved?.storePath).toBe("/tmp/sessions.json");
    expect(retrieved?.contextWindowTokens).toBe(200_000);
  });

  it("keeps separate runtimes for different session managers", () => {
    const sm1 = {};
    const sm2 = {};
    setContextPruningRuntime(sm1, {
      settings: makeSettings(),
      isToolPrunable: () => true,
      sessionKey: "key1",
    });
    setContextPruningRuntime(sm2, {
      settings: makeSettings(),
      isToolPrunable: () => true,
      sessionKey: "key2",
    });
    expect(getContextPruningRuntime(sm1)?.sessionKey).toBe("key1");
    expect(getContextPruningRuntime(sm2)?.sessionKey).toBe("key2");
  });

  it("sessionKey and storePath are optional (backward compatible)", () => {
    const sm = {};
    const value: ContextPruningRuntimeValue = {
      settings: makeSettings(),
      isToolPrunable: () => true,
    };
    setContextPruningRuntime(sm, value);
    const retrieved = getContextPruningRuntime(sm);
    expect(retrieved?.sessionKey).toBeUndefined();
    expect(retrieved?.storePath).toBeUndefined();
  });
});
