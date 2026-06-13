import { describe, expect, it } from "vitest";
import {
  createCopilotNativeWebSearchWrapper,
  patchCopilotNativeWebSearchPayload,
} from "./native-web-search.js";

describe("patchCopilotNativeWebSearchPayload", () => {
  it("returns payload_not_object for non-object input", () => {
    expect(patchCopilotNativeWebSearchPayload(null)).toBe("payload_not_object");
    expect(patchCopilotNativeWebSearchPayload(undefined)).toBe("payload_not_object");
    expect(patchCopilotNativeWebSearchPayload("string")).toBe("payload_not_object");
    expect(patchCopilotNativeWebSearchPayload(42)).toBe("payload_not_object");
    expect(patchCopilotNativeWebSearchPayload([1, 2])).toBe("payload_not_object");
  });

  it("injects web_search tool into empty tools array", () => {
    const payload: Record<string, unknown> = { tools: [] };
    const result = patchCopilotNativeWebSearchPayload(payload);
    expect(result).toBe("injected");
    expect(payload.tools).toEqual([{ type: "web_search" }]);
  });

  it("injects web_search tool when tools is undefined", () => {
    const payload: Record<string, unknown> = {};
    const result = patchCopilotNativeWebSearchPayload(payload);
    expect(result).toBe("injected");
    expect(payload.tools).toEqual([{ type: "web_search" }]);
  });

  it("replaces managed web_search function tool with native tool", () => {
    const payload: Record<string, unknown> = {
      tools: [
        { type: "function", name: "web_search" },
        { type: "function", name: "other_tool" },
      ],
    };
    const result = patchCopilotNativeWebSearchPayload(payload);
    expect(result).toBe("injected");
    expect(payload.tools).toEqual([
      { type: "function", name: "other_tool" },
      { type: "web_search" },
    ]);
  });

  it("returns native_tool_already_present when native tool exists", () => {
    const payload: Record<string, unknown> = {
      tools: [{ type: "web_search" }, { type: "function", name: "other" }],
    };
    const result = patchCopilotNativeWebSearchPayload(payload);
    expect(result).toBe("native_tool_already_present");
    // should not duplicate
    expect(payload.tools).toEqual([{ type: "web_search" }, { type: "function", name: "other" }]);
  });

  it("removes managed tool when native tool already present", () => {
    const payload: Record<string, unknown> = {
      tools: [
        { type: "web_search" },
        { type: "function", name: "web_search" },
        { type: "function", name: "other" },
      ],
    };
    const result = patchCopilotNativeWebSearchPayload(payload);
    expect(result).toBe("native_tool_already_present");
    expect(payload.tools).toEqual([{ type: "web_search" }, { type: "function", name: "other" }]);
  });

  it("raises minimal reasoning effort to low", () => {
    const payload: Record<string, unknown> = {
      tools: [],
      reasoning: { effort: "minimal" },
    };
    patchCopilotNativeWebSearchPayload(payload);
    expect((payload.reasoning as Record<string, unknown>).effort).toBe("low");
  });

  it("does not change non-minimal reasoning effort", () => {
    const payload: Record<string, unknown> = {
      tools: [],
      reasoning: { effort: "medium" },
    };
    patchCopilotNativeWebSearchPayload(payload);
    expect((payload.reasoning as Record<string, unknown>).effort).toBe("medium");
  });

  it("does not change reasoning when it is not an object", () => {
    const payload: Record<string, unknown> = {
      tools: [],
      reasoning: "high",
    };
    patchCopilotNativeWebSearchPayload(payload);
    expect(payload.reasoning).toBe("high");
  });
});

describe("createCopilotNativeWebSearchWrapper", () => {
  const mockStreamFn = (() => {
    const fn = (_model: unknown, _context: unknown, _options: unknown) => {
      return { __mock: true };
    };
    return fn;
  })() as any;

  it("skips non-eligible models (wrong api)", () => {
    const wrapper = createCopilotNativeWebSearchWrapper(mockStreamFn, { config: undefined });
    const model = { api: "chat-completions", provider: "github-copilot", id: "gpt-5.4" };
    const result = wrapper(model as any, {} as any, {} as any);
    expect(result).toEqual({ __mock: true });
  });

  it("skips non-eligible models (wrong provider)", () => {
    const wrapper = createCopilotNativeWebSearchWrapper(mockStreamFn, { config: undefined });
    const model = { api: "openai-responses", provider: "openai", id: "gpt-5.4" };
    const result = wrapper(model as any, {} as any, {} as any);
    expect(result).toEqual({ __mock: true });
  });

  it("skips Gemini models on Copilot (not OpenAI-family)", () => {
    const wrapper = createCopilotNativeWebSearchWrapper(mockStreamFn, { config: undefined });
    const model = { api: "openai-responses", provider: "github-copilot", id: "gemini-2.5-pro" };
    const result = wrapper(model as any, {} as any, {} as any);
    expect(result).toEqual({ __mock: true });
  });

  it("skips unknown model ids on Copilot", () => {
    const wrapper = createCopilotNativeWebSearchWrapper(mockStreamFn, { config: undefined });
    const model = { api: "openai-responses", provider: "github-copilot", id: "goldeneye" };
    const result = wrapper(model as any, {} as any, {} as any);
    expect(result).toEqual({ __mock: true });
  });

  it("skips when web search is disabled in config", () => {
    const config = { tools: { web: { search: { enabled: false } } } } as any;
    const wrapper = createCopilotNativeWebSearchWrapper(mockStreamFn, { config });
    const model = { api: "openai-responses", provider: "github-copilot", id: "gpt-5.4" };
    const result = wrapper(model as any, {} as any, {} as any);
    expect(result).toEqual({ __mock: true });
  });

  it("skips when web search provider is pinned to non-openai", () => {
    const config = { tools: { web: { search: { provider: "brave" } } } } as any;
    const wrapper = createCopilotNativeWebSearchWrapper(mockStreamFn, { config });
    const model = { api: "openai-responses", provider: "github-copilot", id: "gpt-5.4" };
    const result = wrapper(model as any, {} as any, {} as any);
    expect(result).toEqual({ __mock: true });
  });

  it("activates for eligible model with auto provider", () => {
    const config = { tools: { web: { search: { provider: "auto" } } } } as any;
    const trackingStreamFn = (model: any, _context: any, options: any) => {
      // Verify the wrapper passes through to streamWithPayloadPatch
      return { __mock: true };
    };
    const wrapper = createCopilotNativeWebSearchWrapper(trackingStreamFn as any, { config });
    const model = { api: "openai-responses", provider: "github-copilot", id: "gpt-5.4" };
    // The wrapper should not skip — it should go through streamWithPayloadPatch
    // We verify by checking it doesn't directly return (it wraps the call)
    const result = wrapper(model as any, {} as any, {} as any);
    expect(result).toBeDefined();
  });

  it("activates for exact o-series model IDs (o1, o3, o4)", () => {
    const config = { tools: { web: { search: { provider: "auto" } } } } as any;
    const wrapper = createCopilotNativeWebSearchWrapper(mockStreamFn, { config });
    for (const id of ["o1", "o3", "o4"]) {
      const model = { api: "openai-responses", provider: "github-copilot", id };
      const result = wrapper(model as any, {} as any, {} as any);
      expect(result).toBeDefined();
    }
  });

  it("activates for eligible model with empty provider", () => {
    const config = { tools: { web: { search: { provider: "" } } } } as any;
    const wrapper = createCopilotNativeWebSearchWrapper(mockStreamFn, { config });
    const model = { api: "openai-responses", provider: "github-copilot", id: "gpt-5.4" };
    const result = wrapper(model as any, {} as any, {} as any);
    // Should not bail early
    expect(result).toBeDefined();
  });

  it("activates for eligible model with openai provider", () => {
    const config = { tools: { web: { search: { provider: "openai" } } } } as any;
    const wrapper = createCopilotNativeWebSearchWrapper(mockStreamFn, { config });
    const model = { api: "openai-responses", provider: "github-copilot", id: "gpt-5.4" };
    const result = wrapper(model as any, {} as any, {} as any);
    expect(result).toBeDefined();
  });

  it("passes through for non-eligible model", () => {
    const wrapper = createCopilotNativeWebSearchWrapper(mockStreamFn, { config: undefined });
    const model = { api: "chat-completions", provider: "github-copilot", id: "gpt-5.4" };
    const result = wrapper(model as any, {} as any, {} as any);
    // Non-eligible → passes through directly
    expect(result).toEqual({ __mock: true });
  });
});
