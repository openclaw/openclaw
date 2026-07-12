// Whatsapp tests cover doctor contract plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract.js";

function whatsappConfig(entry: Record<string, unknown>): OpenClawConfig {
  return { channels: { whatsapp: entry } } as never;
}

describe("whatsapp streaming legacy config rules", () => {
  const rootRule = legacyConfigRules.find((rule) => rule.path.join(".") === "channels.whatsapp");

  it("matches flat delivery aliases but not the nested shape", () => {
    expect(rootRule?.match?.({ blockStreaming: true }, {})).toBe(true);
    expect(rootRule?.match?.({ streaming: { block: { enabled: true } } }, {})).toBe(false);
  });
});

describe("whatsapp normalizeCompatibilityConfig streaming aliases", () => {
  it("moves flat delivery aliases at root and account level with root seeding", () => {
    const result = normalizeCompatibilityConfig({
      cfg: whatsappConfig({
        chunkMode: "newline",
        blockStreaming: false,
        accounts: {
          personal: { blockStreamingCoalesce: { minChars: 20 } },
        },
      }),
    });

    const whatsapp = result.config.channels?.whatsapp as unknown as Record<string, unknown>;
    expect(whatsapp.streaming).toEqual({ chunkMode: "newline", block: { enabled: false } });
    expect(whatsapp.chunkMode).toBeUndefined();
    expect(whatsapp.blockStreaming).toBeUndefined();
    const personal = (whatsapp.accounts as Record<string, Record<string, unknown>>).personal;
    // WhatsApp's account merge replaces root streaming wholesale, so the
    // migrated account object carries the inherited root delivery settings.
    expect(personal?.streaming).toEqual({
      chunkMode: "newline",
      block: { enabled: false, coalesce: { minChars: 20 } },
    });
    expect(personal?.blockStreamingCoalesce).toBeUndefined();
  });

  it("keeps the legacy ackReaction migration and stays idempotent", () => {
    const first = normalizeCompatibilityConfig({
      cfg: {
        messages: { ackReaction: "👀" },
        channels: { whatsapp: { blockStreaming: true } },
      } as never,
    });
    const whatsapp = first.config.channels?.whatsapp as unknown as Record<string, unknown>;
    expect(whatsapp.ackReaction).toEqual({ emoji: "👀", direct: false, group: "mentions" });
    expect(whatsapp.streaming).toEqual({ block: { enabled: true } });

    const second = normalizeCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toEqual([]);
  });
});
