import { describe, expect, it } from "vitest";
import {
  parseTelegramAgentChoiceCallbackData,
  parseTelegramOpaqueCallbackData,
} from "./native-command-callback-data.js";
import { telegramOutbound } from "./outbound-adapter.js";

const presentation = {
  blocks: [
    {
      type: "buttons" as const,
      buttons: [{ label: "Deploy", action: { type: "callback" as const, value: "deploy prod" } }],
    },
  ],
};

type RenderedTelegramData = { buttons?: Array<Array<{ text: string; callback_data?: string }>> };

describe("telegramOutbound renderPresentation typed callback ownership", () => {
  // Core renders presentation through this hook before sendPayload, so the
  // owner must already be applied here; sendPayload keeps rendered buttons as-is.
  it.each([
    {
      label: "agent-owned for host message-tool sends",
      actionOrigin: "message-tool" as const,
      callbackData: "tgac1:7ok4o:deploy prod",
      parse: parseTelegramAgentChoiceCallbackData,
    },
    {
      label: "plugin-owned without a host origin",
      actionOrigin: undefined,
      callbackData: "tgcb1:7ok4o:deploy prod",
      parse: parseTelegramOpaqueCallbackData,
    },
  ])("materializes typed buttons $label", async ({ actionOrigin, callbackData, parse }) => {
    const rendered = await telegramOutbound.renderPresentation?.({
      payload: { text: "Deploy?" },
      presentation,
      ctx: { cfg: {}, to: "123", ...(actionOrigin ? { actionOrigin } : {}) } as never,
    });

    const telegramData = rendered?.channelData?.telegram as RenderedTelegramData | undefined;
    expect(telegramData?.buttons).toEqual([[{ text: "Deploy", callback_data: callbackData }]]);
    expect(parse(callbackData)).toBe("deploy prod");
    expect(rendered?.presentation).toBeUndefined();
  });

  it("keeps buttons materialized by renderPresentation when sendPayload runs later", async () => {
    const rendered = await telegramOutbound.renderPresentation?.({
      payload: { text: "Deploy?" },
      presentation,
      ctx: { cfg: {}, to: "123", actionOrigin: "message-tool" } as never,
    });
    const telegramData = rendered?.channelData?.telegram as RenderedTelegramData | undefined;
    expect(telegramData?.buttons?.[0]?.[0]?.callback_data).toBe("tgac1:7ok4o:deploy prod");
    // A later owner-less canonicalization (the sendPayload step of a recovered
    // row) must not re-wrap or downgrade the already encoded agent envelope.
    const resent = await telegramOutbound.renderPresentation?.({
      payload: rendered ?? {},
      presentation,
      ctx: { cfg: {}, to: "123" } as never,
    });
    const resentData = resent?.channelData?.telegram as RenderedTelegramData | undefined;
    expect(resentData?.buttons).toEqual(telegramData?.buttons);
  });
});
