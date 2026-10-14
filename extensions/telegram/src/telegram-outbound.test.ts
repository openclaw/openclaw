// Telegram tests cover telegram outbound plugin behavior.
import { describe, expect, it } from "vitest";
import { telegramOutbound } from "./outbound-adapter.js";
import { clearTelegramRuntimeForTest as clearTelegramRuntime } from "./runtime.test-support.js";

describe("telegramPlugin outbound", () => {
  it("resolves the rich-message delivery limit", () => {
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
  it("strips GLM arg_key shadow XML and keeps a finished literal marker", () => {
    clearTelegramRuntime();
    const shadow =
      "Visible\n<tool_call>exec<arg_key>command</arg_key><arg_value>echo redacted</arg_value></tool_call>\nDone.";
    const literal = "Use <tool_call>exec<arg_key> literally. Example: `</arg_key>`.";
    const cfg = { channels: { telegram: { richMessages: true } } };
    expect(telegramOutbound.sanitizeText?.({ text: shadow, payload: { text: shadow } })).toBe(
      "Visible\n\nDone.",
    );
    expect(
      telegramOutbound.sanitizeText?.({
        text: literal,
        payload: { text: literal },
        cfg,
        accountId: "default",
      }),
    ).toBe(literal);
  });

  it("strips assistant-visible tool traces before outbound delivery", () => {
    clearTelegramRuntime();
    const text = 'Done.\n⚠️ 🛠️ `search "Pipeline" in ~/.openclaw/workspace-* (agent)` failed';

    expect(telegramOutbound.sanitizeText?.({ text, payload: { text } })).toBe("Done.");
  });
});
