import { describe, expect, it, vi } from "vitest";
import { createAnthropicNativeSearchStreamWrapper } from "./anthropic-native-search-wrapper.js";

describe("createAnthropicNativeSearchStreamWrapper", () => {
  it("injects web_search server tool into anthropic-messages payloads", () => {
    const capturedPayloads: any[] = [];
    const fakeStream = vi.fn((_model: any, _context: any, options: any) => {
      // Simulate calling onPayload
      if (options?.onPayload) {
        const payload = { tools: [{ type: "function", name: "other_tool" }] };
        options.onPayload(payload);
        capturedPayloads.push(payload);
      }
      return { type: "stream", events: [] } as any;
    });

    const wrapped = createAnthropicNativeSearchStreamWrapper(fakeStream as any);
    wrapped({ api: "anthropic-messages" } as any, {} as any, {} as any);

    expect(fakeStream).toHaveBeenCalledOnce();
    expect(capturedPayloads[0].tools).toHaveLength(2);
    expect(capturedPayloads[0].tools[1].type).toMatch(/^web_search_/);
    expect(capturedPayloads[0].tools[1].name).toBe("web_search");
  });

  it("does not inject if web_search server tool already present", () => {
    const capturedPayloads: any[] = [];
    const fakeStream = vi.fn((_model: any, _context: any, options: any) => {
      if (options?.onPayload) {
        const payload = { tools: [{ type: "web_search_20260209", name: "web_search" }] };
        options.onPayload(payload);
        capturedPayloads.push(payload);
      }
      return { type: "stream", events: [] } as any;
    });

    const wrapped = createAnthropicNativeSearchStreamWrapper(fakeStream as any);
    wrapped({ api: "anthropic-messages" } as any, {} as any, {} as any);

    expect(capturedPayloads[0].tools).toHaveLength(1);
  });

  it("passes through non-anthropic API calls unchanged", () => {
    const fakeStream = vi.fn(() => ({ type: "stream" }) as any);
    const wrapped = createAnthropicNativeSearchStreamWrapper(fakeStream as any);

    wrapped({ api: "openai-chat" } as any, {} as any, { onPayload: vi.fn() } as any);

    // onPayload should be the original, not our wrapper
    const passedOptions = fakeStream.mock.calls[0][2];
    expect(passedOptions.onPayload).toBeDefined();
  });
});
