// Telegram outbound payload normalization tests.
import { describe, expect, it } from "vitest";
import { telegramOutbound } from "./outbound-adapter.js";

describe("telegramOutbound normalizePayload", () => {
  it("normalizes metadata-only direct payloads with provided fallback text", () => {
    const normalized = telegramOutbound.normalizePayload?.({
      cfg: {} as never,
      payload: {
        text: "   ",
        channelData: {
          openclawDirectDeliveryFallbackText: "Pablo Daily Summary\n- Review the stuck cron.",
          telegram: {
            buttons: [[{ text: "Open task", url: "https://example.test/task" }]],
          },
        },
      },
    });

    expect(normalized).toEqual({
      text: "Pablo Daily Summary\n- Review the stuck cron.",
      channelData: {
        openclawDirectDeliveryFallbackText: "Pablo Daily Summary\n- Review the stuck cron.",
        telegram: {
          buttons: [[{ text: "Open task", url: "https://example.test/task" }]],
        },
      },
    });
  });

  it("keeps reaction-only payloads textless during payload normalization", () => {
    const normalized = telegramOutbound.normalizePayload?.({
      cfg: {} as never,
      payload: {
        channelData: {
          openclawDirectDeliveryFallbackText: "Pablo Daily Summary\n- Review the stuck cron.",
          telegram: {
            reaction: { emoji: "+1", replyToId: "123" },
          },
        },
      },
    });

    expect(normalized).toEqual({
      channelData: {
        openclawDirectDeliveryFallbackText: "Pablo Daily Summary\n- Review the stuck cron.",
        telegram: {
          reaction: { emoji: "+1", replyToId: "123" },
        },
      },
    });
  });

  it("suppresses metadata-only button payloads when no fallback text exists", () => {
    const normalized = telegramOutbound.normalizePayload?.({
      cfg: {} as never,
      payload: {
        channelData: {
          telegram: {
            buttons: [[{ text: "Open task", url: "https://example.test/task" }]],
          },
        },
      },
    });

    expect(normalized).toBeNull();
  });
});
