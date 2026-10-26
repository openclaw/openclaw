import { describe, expect, it } from "vitest";
import { buildAgentHarnessQuestionPromptPayload } from "../../../src/agents/harness/user-input-bridge.js";
import { createTelegramOutboundAdapter } from "./outbound-adapter.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";

const questionId = "ask_0123456789abcdef0123456789abcdef";

function prompt() {
  return buildAgentHarnessQuestionPromptPayload({
    questionId,
    questionIndex: 1,
    questions: [
      {
        id: "details",
        header: "Details",
        question: "Choose details",
        options: [{ label: "Logs" }, { label: "Screenshots" }],
        multiSelect: true,
        isOther: true,
      },
    ],
  });
}

describe("rich question HTTP delivery", () => {
  const fixture = useTelegramHttpFixture();
  const adapter = createTelegramOutboundAdapter();
  it("sends in-message buttons without duplicate reply markup", async () => {
    await adapter.sendPayload!({
      cfg: { channels: { telegram: { ...fixture.cfg.channels.telegram, richMessages: true } } },
      to: "123",
      accountId: "default",
      payload: prompt(),
    } as never);
    expect(fixture.requests.map(({ method }) => method)).toEqual(["sendRichMessage"]);
    expect(fixture.requests[0]?.fields.reply_markup).toBeUndefined();
    const rich = fixture.requests[0]?.fields.rich_message as {
      blocks?: Array<{ type: string; buttons?: Array<{ callback_data?: string }> }>;
    };
    expect(rich.blocks?.filter((block) => block.type === "buttons")).toHaveLength(4);
    expect(rich.blocks?.[1]?.buttons?.[0]?.callback_data).toBe(`tgq2:${questionId}:1:0:a`);
  });

  it("preserves an actionable keyboard if Telegram rejects the rich body", async () => {
    fixture.rejections.push("Bad Request: RICH_MESSAGE_BUTTONS_INVALID");
    await adapter.sendPayload!({
      cfg: { channels: { telegram: { ...fixture.cfg.channels.telegram, richMessages: true } } },
      to: "123",
      accountId: "default",
      payload: prompt(),
    } as never);
    expect(fixture.requests.map(({ method }) => method)).toEqual([
      "sendRichMessage",
      "sendMessage",
    ]);
    expect(fixture.requests[1]?.fields.reply_markup).toMatchObject({
      inline_keyboard: expect.any(Array),
    });
  });
});
