import { describe, expect, it } from "vitest";
import {
  type CacheConfig,
  createVolcengineCacheWrapper,
  filterSessionCacheInput,
  injectInstructionsIntoInput,
  resolveCacheConfig,
  resolveCacheKey,
} from "./cache.js";

describe("resolveCacheConfig", () => {
  it("returns undefined when extraParams is undefined", () => {
    expect(resolveCacheConfig(undefined)).toBeUndefined();
  });

  it("returns undefined when no cache key", () => {
    expect(resolveCacheConfig({ someOther: true })).toBeUndefined();
  });

  it("returns undefined for non-object cache values", () => {
    expect(resolveCacheConfig({ cache: true })).toBeUndefined();
    expect(resolveCacheConfig({ cache: false })).toBeUndefined();
    expect(resolveCacheConfig({ cache: "yes" })).toBeUndefined();
  });

  it("returns undefined when enable is not true", () => {
    expect(resolveCacheConfig({ cache: {} })).toBeUndefined();
    expect(resolveCacheConfig({ cache: { enable: false } })).toBeUndefined();
  });

  it("returns config with defaults when enable: true", () => {
    const result = resolveCacheConfig({ cache: { enable: true } });
    expect(result).toEqual<CacheConfig>({
      enable: true,
      ttlSec: 3600,
      thinking: undefined,
    });
  });

  it("respects ttlSec override", () => {
    const result = resolveCacheConfig({ cache: { enable: true, ttlSec: 7200 } });
    expect(result?.ttlSec).toBe(7200);
  });

  it("thinking is undefined when not configured", () => {
    const result = resolveCacheConfig({ cache: { enable: true } });
    expect(result?.thinking).toBeUndefined();
  });

  it("respects thinking: true", () => {
    const result = resolveCacheConfig({ cache: { enable: true, thinking: true } });
    expect(result?.thinking).toBe(true);
  });

  it("respects thinking: false", () => {
    const result = resolveCacheConfig({ cache: { enable: true, thinking: false } });
    expect(result?.thinking).toBe(false);
  });
});

describe("resolveCacheKey", () => {
  const base = {
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    modelId: "test-model",
    context: {
      systemPrompt: "You are helpful",
      messages: [{ timestamp: 1000 }],
      tools: [{ name: "tool1" }],
    },
  };

  it("includes baseUrl and modelId with sessionId", () => {
    expect(resolveCacheKey({ ...base, options: { sessionId: "my-session" } })).toBe(
      "https://ark.cn-beijing.volces.com/api/v3/test-model:my-session",
    );
  });

  it("different models with same sessionId produce different keys", () => {
    const key1 = resolveCacheKey({ ...base, options: { sessionId: "s1" } });
    const key2 = resolveCacheKey({ ...base, modelId: "other-model", options: { sessionId: "s1" } });
    expect(key1).not.toBe(key2);
  });

  it("different baseUrls with same model produce different keys", () => {
    const key1 = resolveCacheKey({ ...base, options: { sessionId: "s1" } });
    const key2 = resolveCacheKey({
      ...base,
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      options: { sessionId: "s1" },
    });
    expect(key1).not.toBe(key2);
  });

  it("ignores empty sessionId", () => {
    const key = resolveCacheKey({ ...base, options: { sessionId: "  " } });
    expect(key).not.toBe("  ");
    expect(key).toContain("test-model:");
  });

  it("generates deterministic key from context", () => {
    const key1 = resolveCacheKey(base);
    const key2 = resolveCacheKey(base);
    expect(key1).toBe(key2);
  });

  it("different models produce different keys", () => {
    const key1 = resolveCacheKey(base);
    const key2 = resolveCacheKey({ ...base, modelId: "other-model" });
    expect(key1).not.toBe(key2);
  });

  it("different system prompts produce different keys", () => {
    const key1 = resolveCacheKey(base);
    const key2 = resolveCacheKey({
      ...base,
      context: { ...base.context, systemPrompt: "Different" },
    });
    expect(key1).not.toBe(key2);
  });
});

describe("filterSessionCacheInput", () => {
  it("returns non-array input as-is", () => {
    expect(filterSessionCacheInput("hello")).toBe("hello");
    expect(filterSessionCacheInput(null)).toBe(null);
  });

  it("filters trailing user messages from input", () => {
    const input = [
      { role: "assistant", content: "old" },
      { role: "user", content: "new1" },
      { role: "user", content: "new2" },
    ];
    const result = filterSessionCacheInput(input);
    expect(result).toEqual([
      { role: "user", content: "new1" },
      { role: "user", content: "new2" },
    ]);
  });

  it("includes function_call_output in role-based filtering", () => {
    const input = [
      { role: "assistant", content: "thought" },
      { role: "user", content: "msg" },
      { type: "function_call_output", call_id: "c1", output: "result" },
    ];
    const result = filterSessionCacheInput(input);
    expect(result).toEqual([
      { role: "user", content: "msg" },
      { type: "function_call_output", call_id: "c1", output: "result" },
    ]);
  });

  it("returns full input when role-based filtering finds nothing", () => {
    const input = [{ role: "assistant", content: "only assistant" }];
    const result = filterSessionCacheInput(input);
    expect(result).toBe(input);
  });
});

describe("injectInstructionsIntoInput", () => {
  it("returns input unchanged when no instructions", () => {
    const input = [{ role: "user" }];
    expect(injectInstructionsIntoInput({ input, instructions: undefined })).toBe(input);
    expect(injectInstructionsIntoInput({ input, instructions: "" })).toBe(input);
  });

  it("returns input unchanged when input is not array", () => {
    expect(injectInstructionsIntoInput({ input: "hello", instructions: "sys" })).toBe("hello");
  });

  it("prepends system message", () => {
    const input = [{ role: "user", content: "hi" }];
    const result = injectInstructionsIntoInput({ input, instructions: "Be helpful" });
    expect(result).toEqual([
      { type: "message", role: "system", content: "Be helpful" },
      { role: "user", content: "hi" },
    ]);
  });
});

describe("createVolcengineCacheWrapper", () => {
  it("returns undefined when baseStreamFn is undefined", () => {
    expect(createVolcengineCacheWrapper(undefined, undefined)).toBeUndefined();
  });

  it("returns base stream when cache is not enabled", () => {
    const base = (() => {}) as unknown as Parameters<typeof createVolcengineCacheWrapper>[0];
    const result = createVolcengineCacheWrapper(base, {});
    expect(result).toBe(base);
  });

  it("returns wrapped function when cache is enabled", () => {
    const base = (() => {}) as unknown as Parameters<typeof createVolcengineCacheWrapper>[0];
    const result = createVolcengineCacheWrapper(base, { cache: { enable: true } });
    expect(result).not.toBe(base);
    expect(typeof result).toBe("function");
  });

  it("passes through for non-responses API models", () => {
    const base = (() => "base-result") as unknown as Parameters<
      typeof createVolcengineCacheWrapper
    >[0];
    const wrapped = createVolcengineCacheWrapper(base, { cache: { enable: true } })!;
    const model = { id: "test", api: "openai-completions" } as Parameters<typeof wrapped>[0];
    const context = { messages: [] } as unknown as Parameters<typeof wrapped>[1];
    const result = wrapped(model, context, {});
    expect(result).toBe("base-result");
  });
});
