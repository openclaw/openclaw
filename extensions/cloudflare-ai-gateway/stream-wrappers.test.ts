import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapCloudflareAiGatewayProviderStream } from "./stream-wrappers.js";

const { warnMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: warnMock,
  }),
}));

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/runtime-env");
  vi.resetModules();
});

describe("wrapCloudflareAiGatewayProviderStream", () => {
  beforeEach(() => {
    warnMock.mockClear();
  });

  it("defaults a missing model API to Anthropic prefill stripping", () => {
    const payload = {
      thinking: { type: "adaptive" },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
        { role: "assistant", content: '"status"' },
      ],
    };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      options?.onPayload?.(payload as never, model as never);
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = wrapCloudflareAiGatewayProviderStream({
      model: {},
      streamFn: baseStreamFn,
    } as never);
    expect(wrapped).not.toBe(baseStreamFn);
    if (!wrapped) {
      throw new Error("expected Cloudflare AI Gateway stream wrapper");
    }
    void wrapped(
      { provider: "cloudflare-ai-gateway", api: "anthropic-messages" } as never,
      {} as never,
      {},
    );

    expect(payload.messages).toEqual([{ role: "user", content: "Return JSON." }]);
    expect(warnMock).toHaveBeenCalledWith(
      "removed 2 trailing assistant prefill messages because Anthropic extended thinking requires conversations to end with a user turn",
    );
  });

  it("leaves non-Anthropic model APIs on the original stream path", () => {
    let onPayloadWasInstalled = false;
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      onPayloadWasInstalled = typeof options?.onPayload === "function";
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = wrapCloudflareAiGatewayProviderStream({
      model: { api: "openai-completions" },
      streamFn: baseStreamFn,
    } as never);
    void wrapped?.({ api: "openai-completions" } as never, {} as never, {});

    expect(wrapped).toBe(baseStreamFn);
    expect(onPayloadWasInstalled).toBe(false);
    expect(warnMock).not.toHaveBeenCalled();
  });
});
