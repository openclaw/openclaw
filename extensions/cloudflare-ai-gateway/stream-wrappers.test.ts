import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { createCloudflareAiGatewayAnthropicThinkingPrefillWrapper } from "./stream-wrappers.js";

function runWrapper(payload: Record<string, unknown>): Record<string, unknown> {
  const wrapper = createCloudflareAiGatewayAnthropicThinkingPrefillWrapper(((
    _model,
    _context,
    options,
  ) => {
    options?.onPayload?.(payload as never, {} as never);
    return {} as ReturnType<StreamFn>;
  }) as StreamFn);
  void wrapper(
    { provider: "cloudflare-ai-gateway", api: "anthropic-messages" } as never,
    {} as never,
    {},
  );
  return payload;
}

describe("createCloudflareAiGatewayAnthropicThinkingPrefillWrapper", () => {
  it("removes trailing assistant prefill when thinking is enabled", () => {
    const payload = runWrapper({
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    });

    expect(payload.messages).toEqual([{ role: "user", content: "Return JSON." }]);
  });

  it("removes multiple trailing assistant prefill messages until the conversation ends with user", () => {
    const payload = runWrapper({
      thinking: { type: "adaptive" },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
        { role: "assistant", content: '"status"' },
      ],
    });

    expect(payload.messages).toEqual([{ role: "user", content: "Return JSON." }]);
  });

  it("keeps assistant prefill when thinking is disabled", () => {
    const payload = runWrapper({
      thinking: { type: "disabled" },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    });

    expect(payload.messages).toHaveLength(2);
  });

  it("keeps trailing assistant tool use turns when thinking is enabled", () => {
    const payload = runWrapper({
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        { role: "user", content: "Read a file." },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "Read" }],
        },
      ],
    });

    expect(payload.messages).toHaveLength(2);
  });

  it("leaves payloads without a messages array unchanged", () => {
    const payload = runWrapper({
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: "not-an-array",
    });

    expect(payload).toEqual({
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: "not-an-array",
    });
  });
});
