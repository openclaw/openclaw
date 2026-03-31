import { describe, expect, it, vi } from "vitest";
import {
  createCopilotPayloadCompatibilityWrapper,
  isCopilotReasoningUnsupportedModel,
} from "./index.js";

describe("isCopilotReasoningUnsupportedModel", () => {
  it("returns true for gpt-5-mini", () => {
    expect(isCopilotReasoningUnsupportedModel("gpt-5-mini")).toBe(true);
  });

  it("returns true for gpt-5-mini with date suffix", () => {
    expect(isCopilotReasoningUnsupportedModel("gpt-5-mini-2025-01-31")).toBe(true);
  });

  it("returns true for gpt-5-mini with arbitrary suffix", () => {
    expect(isCopilotReasoningUnsupportedModel("gpt-5-mini-preview")).toBe(true);
  });

  it("returns true for gpt-5-mini with whitespace", () => {
    expect(isCopilotReasoningUnsupportedModel("  gpt-5-mini  ")).toBe(true);
  });

  it("returns true for gpt-5-mini with mixed case", () => {
    expect(isCopilotReasoningUnsupportedModel("GPT-5-MINI")).toBe(true);
  });

  it("returns false for gpt-5.2", () => {
    expect(isCopilotReasoningUnsupportedModel("gpt-5.2")).toBe(false);
  });

  it("returns false for gpt-5.2-codex", () => {
    expect(isCopilotReasoningUnsupportedModel("gpt-5.2-codex")).toBe(false);
  });

  it("returns false for non-string input", () => {
    expect(isCopilotReasoningUnsupportedModel(null)).toBe(false);
    expect(isCopilotReasoningUnsupportedModel(undefined)).toBe(false);
    expect(isCopilotReasoningUnsupportedModel(123)).toBe(false);
    expect(isCopilotReasoningUnsupportedModel({})).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isCopilotReasoningUnsupportedModel("")).toBe(false);
  });

  it("returns false for whitespace-only string", () => {
    expect(isCopilotReasoningUnsupportedModel("   ")).toBe(false);
  });

  it("returns false for partial match in middle of string", () => {
    expect(isCopilotReasoningUnsupportedModel("my-gpt-5-mini-model")).toBe(false);
  });
});

describe("createCopilotPayloadCompatibilityWrapper", () => {
  it("returns undefined when streamFn is undefined", () => {
    const result = createCopilotPayloadCompatibilityWrapper(undefined);
    expect(result).toBeUndefined();
  });

  it("returns null when streamFn is null", () => {
    const result = createCopilotPayloadCompatibilityWrapper(null as any);
    expect(result).toBeNull();
  });

  it("strips reasoning and reasoning_effort from payload for gpt-5-mini", () => {
    const mockStreamFn = vi.fn((model, context, options) => {
      // Simulate calling onPayload
      const payload = {
        reasoning: "some reasoning",
        reasoning_effort: "high",
        other_field: "value",
      };
      options?.onPayload?.(payload, model);
      return { type: "message_start" } as any;
    });

    const wrapped = createCopilotPayloadCompatibilityWrapper(mockStreamFn as any);
    expect(wrapped).toBeDefined();

    const mockModel = { id: "gpt-5-mini" };
    const mockContext = {};
    const mockOnPayload = vi.fn();

    wrapped?.(mockModel as any, mockContext as any, { onPayload: mockOnPayload });

    expect(mockOnPayload).toHaveBeenCalledTimes(1);
    const passedPayload = mockOnPayload.mock.calls[0][0];
    expect(passedPayload).toEqual({ other_field: "value" });
    expect(passedPayload).not.toHaveProperty("reasoning");
    expect(passedPayload).not.toHaveProperty("reasoning_effort");
  });

  it("preserves payload fields for non-gpt-5-mini models", () => {
    const mockStreamFn = vi.fn((model, context, options) => {
      const payload = {
        reasoning: "some reasoning",
        reasoning_effort: "high",
        other_field: "value",
      };
      options?.onPayload?.(payload, model);
      return { type: "message_start" } as any;
    });

    const wrapped = createCopilotPayloadCompatibilityWrapper(mockStreamFn as any);

    const mockModel = { id: "gpt-5.2" };
    const mockContext = {};
    const mockOnPayload = vi.fn();

    wrapped?.(mockModel as any, mockContext as any, { onPayload: mockOnPayload });

    expect(mockOnPayload).toHaveBeenCalledTimes(1);
    const passedPayload = mockOnPayload.mock.calls[0][0];
    expect(passedPayload).toEqual({
      reasoning: "some reasoning",
      reasoning_effort: "high",
      other_field: "value",
    });
  });

  it("passes through to original onPayload", () => {
    const mockStreamFn = vi.fn((model, context, options) => {
      const payload = { test: "data" };
      options?.onPayload?.(payload, model);
      return { type: "message_start" } as any;
    });

    const wrapped = createCopilotPayloadCompatibilityWrapper(mockStreamFn as any);

    const mockModel = { id: "gpt-5.2" };
    const mockContext = {};
    const mockOnPayload = vi.fn();

    wrapped?.(mockModel as any, mockContext as any, { onPayload: mockOnPayload });

    expect(mockOnPayload).toHaveBeenCalledWith({ test: "data" }, mockModel);
  });

  it("handles null payload gracefully", () => {
    const mockStreamFn = vi.fn((model, context, options) => {
      options?.onPayload?.(null, model);
      return { type: "message_start" } as any;
    });

    const wrapped = createCopilotPayloadCompatibilityWrapper(mockStreamFn as any);

    const mockModel = { id: "gpt-5-mini" };
    const mockContext = {};
    const mockOnPayload = vi.fn();

    wrapped?.(mockModel as any, mockContext as any, { onPayload: mockOnPayload });

    expect(mockOnPayload).toHaveBeenCalledWith(null, mockModel);
  });

  it("handles missing onPayload option", () => {
    const mockStreamFn = vi.fn((model, context, options) => {
      const payload = { test: "data" };
      options?.onPayload?.(payload, model);
      return { type: "message_start" } as any;
    });

    const wrapped = createCopilotPayloadCompatibilityWrapper(mockStreamFn as any);

    const mockModel = { id: "gpt-5-mini" };
    const mockContext = {};

    expect(() => {
      wrapped?.(mockModel as any, mockContext as any, {});
    }).not.toThrow();
  });

  it("strips reasoning fields for gpt-5-mini-2025-01-31", () => {
    const mockStreamFn = vi.fn((model, context, options) => {
      const payload = {
        reasoning: "some reasoning",
        reasoning_effort: "high",
        other_field: "value",
      };
      options?.onPayload?.(payload, model);
      return { type: "message_start" } as any;
    });

    const wrapped = createCopilotPayloadCompatibilityWrapper(mockStreamFn as any);

    const mockModel = { id: "gpt-5-mini-2025-01-31" };
    const mockContext = {};
    const mockOnPayload = vi.fn();

    wrapped?.(mockModel as any, mockContext as any, { onPayload: mockOnPayload });

    expect(mockOnPayload).toHaveBeenCalledTimes(1);
    const passedPayload = mockOnPayload.mock.calls[0][0];
    expect(passedPayload).toEqual({ other_field: "value" });
    expect(passedPayload).not.toHaveProperty("reasoning");
    expect(passedPayload).not.toHaveProperty("reasoning_effort");
  });

  it("passes through original streamFn call with modified onPayload", () => {
    const mockStreamFn = vi.fn((model, context, options) => {
      // Verify onPayload was passed
      expect(options).toHaveProperty("onPayload");
      return { type: "message_start" } as any;
    });

    const wrapped = createCopilotPayloadCompatibilityWrapper(mockStreamFn as any);

    const mockModel = { id: "gpt-5-mini" };
    const mockContext = { some: "context" };
    const mockOnPayload = vi.fn();

    wrapped?.(mockModel as any, mockContext as any, { onPayload: mockOnPayload });

    expect(mockStreamFn).toHaveBeenCalledTimes(1);
    expect(mockStreamFn).toHaveBeenCalledWith(
      mockModel,
      mockContext,
      expect.objectContaining({ onPayload: expect.any(Function) }),
    );
  });
});
