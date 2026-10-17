import { adaptMessagePresentationForChannel } from "openclaw/plugin-sdk/interactive-runtime";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDiscordOutboundHoisted,
  installDiscordOutboundModuleSpies,
  mockDiscordBoundThreadManager,
  resetDiscordOutboundMocks,
} from "./outbound-adapter.test-harness.js";

const hoisted = createDiscordOutboundHoisted();
await installDiscordOutboundModuleSpies(hoisted);

let discordOutbound: typeof import("./outbound-adapter.js").discordOutbound;

function mockObjectArg(
  source: { mock: { calls: Array<Array<unknown>> } },
  callIndex = 0,
  argIndex = 2,
): Record<string, unknown> {
  const value = source.mock.calls[callIndex]?.[argIndex];
  if (!value || typeof value !== "object") {
    throw new Error(`expected Discord send call ${callIndex} argument ${argIndex} to be an object`);
  }
  return value as Record<string, unknown>;
}

beforeAll(async () => {
  ({ discordOutbound } = await import("./outbound-adapter.js"));
});

describe("Discord outbound copy-text safety", () => {
  beforeEach(() => resetDiscordOutboundMocks(hoisted));

  it("carries disabled hostile-label suppression through bound-thread webhooks", async () => {
    mockDiscordBoundThreadManager(hoisted);
    const sourcePresentation = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [
            {
              label: "Copy @everyone @here <@123> <@!456> <@&789>",
              action: { type: "copy-text" as const, text: "SAFE-TOKEN" },
              disabled: true,
            },
          ],
        },
      ],
    };
    const presentation = adaptMessagePresentationForChannel({
      presentation: sourcePresentation,
      capabilities: discordOutbound.presentationCapabilities,
    });
    const payload = await discordOutbound.renderPresentation?.({
      payload: {},
      presentation,
      sourcePresentation,
      ctx: { cfg: {}, to: "channel:parent-1" },
    } as never);
    if (!payload) {
      throw new Error("expected disabled Discord copy fallback payload");
    }

    await discordOutbound.sendText?.({
      cfg: {},
      to: "channel:parent-1",
      text: "safe fenced copy fallback",
      accountId: "default",
      threadId: "thread-1",
      payload,
    } as never);

    expect(mockObjectArg(hoisted.sendWebhookMessageDiscordMock, 0, 1).allowedMentions).toEqual({
      parse: [],
    });
  });

  it("delivers long hostile copy fallback as inert fragments with mentions suppressed", async () => {
    const copyText = "x".repeat(2100);
    const hostileLabel = "Copy @everyone @here <@123> <@!456> <@&789>";
    const sourcePresentation = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [
            {
              label: hostileLabel,
              action: { type: "copy-text" as const, text: copyText },
            },
          ],
        },
      ],
    };
    const presentation = adaptMessagePresentationForChannel({
      presentation: sourcePresentation,
      capabilities: discordOutbound.presentationCapabilities,
    });

    const payload = await discordOutbound.renderPresentation?.({
      payload: {},
      presentation,
      sourcePresentation,
      ctx: { cfg: {}, to: "channel:123456" },
    } as never);
    if (!payload) {
      throw new Error("expected Discord copy fallback payload");
    }

    const discordData = payload.channelData?.discord as
      | {
          presentationComponents?: { blocks?: Array<{ type?: string; text?: string }> };
          suppressPresentationMentions?: boolean;
        }
      | undefined;
    const textBlocks = (discordData?.presentationComponents?.blocks ?? []).filter(
      (block) => block.type === "text",
    );
    expect(textBlocks.length).toBeGreaterThan(1);
    expect(discordData?.suppressPresentationMentions).toBe(true);
    expect(textBlocks.every((block) => block.text?.includes(hostileLabel))).toBe(true);
    const recovered = textBlocks.map((block) => {
      const text = block.text ?? "";
      const opener = /\n(`{3,}|~{3,})\n/u.exec(text);
      expect(opener).not.toBeNull();
      const fence = opener?.[1] ?? "";
      const start = (opener?.index ?? 0) + (opener?.[0].length ?? 0);
      const close = `\n${fence}`;
      expect(text.endsWith(close)).toBe(true);
      return text.slice(start, -close.length);
    });
    expect(recovered.join("")).toBe(copyText);

    await discordOutbound.sendPayload?.({
      cfg: {},
      to: "channel:123456",
      text: "",
      payload,
    });
    expect(mockObjectArg(hoisted.sendDiscordComponentMessageMock).allowedMentions).toEqual({
      parse: [],
    });
  });
});
