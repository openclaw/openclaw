// Telegram tests cover telegram outbound plugin behavior.
import { describe, expect, it } from "vitest";
import { markdownToTelegramHtml } from "./format.js";
import { telegramOutbound } from "./outbound-adapter.js";
import { clearTelegramRuntimeForTest as clearTelegramRuntime } from "./runtime.test-support.js";

describe("telegramPlugin outbound", () => {
  it("uses static outbound contract when Telegram runtime is uninitialized", () => {
    clearTelegramRuntime();
    expect(telegramOutbound.deliveryMode).toBe("direct");
    expect(telegramOutbound.textChunkLimit).toBe(4000);
    expect(telegramOutbound.presentationCapabilities?.limits?.text?.markdownDialect).toBe(
      "markdown",
    );
    expect(telegramOutbound.pollMaxOptions).toBe(12);
  });

  it("uses the rich-message limit before the shared outbound chunker", () => {
    const resolveLimit = telegramOutbound.resolveEffectiveTextChunkLimit;
    expect(resolveLimit?.({ cfg: {}, accountId: "default", fallbackLimit: 4000 })).toBe(4000);
    expect(
      resolveLimit?.({
        cfg: { channels: { telegram: { richMessages: true } } },
        accountId: "default",
        fallbackLimit: 4000,
      }),
    ).toBe(32768);
  });

  it("preserves an explicitly configured lower rich-message limit", () => {
    expect(
      telegramOutbound.resolveEffectiveTextChunkLimit?.({
        cfg: {
          channels: { telegram: { richMessages: true, textChunkLimit: 1200 } },
        },
        accountId: "default",
        fallbackLimit: 4000,
      }),
    ).toBe(1200);
  });

  it("keeps rich-account legacy HTML at the Telegram text limit", () => {
    expect(
      telegramOutbound.resolveEffectiveTextChunkLimit?.({
        cfg: { channels: { telegram: { richMessages: true } } },
        accountId: "default",
        fallbackLimit: 4000,
        formatting: { parseMode: "HTML" },
      }),
    ).toBe(4000);
  });

  it("uses the selected account's rich-message limit", () => {
    expect(
      telegramOutbound.resolveEffectiveTextChunkLimit?.({
        cfg: {
          channels: {
            telegram: {
              richMessages: false,
              accounts: { rich: { richMessages: true } },
            },
          },
        },
        accountId: "rich",
        fallbackLimit: 4000,
      }),
    ).toBe(32768);
  });

  it("preserves a selected account's lower rich-message limit", () => {
    expect(
      telegramOutbound.resolveEffectiveTextChunkLimit?.({
        cfg: {
          channels: {
            telegram: {
              accounts: { rich: { richMessages: true, textChunkLimit: 1200 } },
            },
          },
        },
        accountId: "rich",
        fallbackLimit: 4000,
      }),
    ).toBe(1200);
  });
  it("strips assistant-visible tool traces before outbound delivery", () => {
    clearTelegramRuntime();
    const text = 'Done.\n⚠️ 🛠️ `search "Pipeline" in ~/.openclaw/workspace-* (agent)` failed';

    expect(telegramOutbound.sanitizeText?.({ text, payload: { text } })).toBe("Done.");
  });

  it("preserves ordinary outbound text while sanitizing", () => {
    clearTelegramRuntime();
    const text = "The pipeline has 3 deals.";

    expect(telegramOutbound.sanitizeText?.({ text, payload: { text } })).toBe(text);
  });

  it("uses Telegram markdown markers for sanitized HTML formatting", () => {
    clearTelegramRuntime();
    const text = `<strong title="b>">bold</strong> <del data-note='s>'>strike</del>`;
    const sanitized = telegramOutbound.sanitizeText?.({ text, payload: { text } });

    expect(sanitized).toBe("**bold** ~~strike~~");
    expect(markdownToTelegramHtml(sanitized ?? "")).toBe("<b>bold</b> <s>strike</s>");
  });
});
