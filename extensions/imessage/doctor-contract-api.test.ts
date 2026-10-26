import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

function normalize(entry: Record<string, unknown>) {
  return normalizeCompatibilityConfig({
    cfg: { channels: { imessage: entry } } as OpenClawConfig,
  });
}

describe("imessage streaming compatibility", () => {
  const rootRule = legacyConfigRules.find(
    (rule) => rule.path.join(".") === "channels.imessage" && rule.message.includes("chunkMode"),
  );
  const accountRule = legacyConfigRules.find(
    (rule) =>
      rule.path.join(".") === "channels.imessage.accounts" && rule.message.includes("chunkMode"),
  );

  it("matches flat delivery aliases at root and account level", () => {
    expect(rootRule?.match?.({ chunkMode: "newline" }, {})).toBe(true);
    expect(rootRule?.match?.({ blockStreaming: true }, {})).toBe(true);
    expect(rootRule?.match?.({ blockStreamingCoalesce: { idleMs: 5 } }, {})).toBe(true);
    expect(rootRule?.match?.({ streaming: { chunkMode: "newline" } }, {})).toBe(false);
    expect(accountRule?.match?.({ work: { blockStreaming: false } }, {})).toBe(true);
    expect(accountRule?.match?.({ work: { streaming: { block: { enabled: true } } } }, {})).toBe(
      false,
    );
  });

  it("moves flat delivery aliases into the nested streaming shape", () => {
    const result = normalize({
      chunkMode: "newline",
      blockStreaming: true,
      accounts: { personal: { blockStreamingCoalesce: { idleMs: 250 } } },
    });

    // Account streaming stays local; runtime owns the root/account merge.
    expect(result.config.channels?.imessage).toEqual({
      streaming: { chunkMode: "newline", block: { enabled: true } },
      accounts: { personal: { streaming: { block: { coalesce: { idleMs: 250 } } } } },
    });
    for (const change of [
      "Moved channels.imessage.chunkMode → channels.imessage.streaming.chunkMode.",
      "Moved channels.imessage.blockStreaming → channels.imessage.streaming.block.enabled.",
      "Moved channels.imessage.accounts.personal.blockStreamingCoalesce → channels.imessage.accounts.personal.streaming.block.coalesce.",
    ]) {
      expect(result.changes).toContain(change);
    }
  });

  it("removes flat aliases when the nested value is already set", () => {
    const result = normalize({ chunkMode: "length", streaming: { chunkMode: "newline" } });

    expect(result.config.channels?.imessage).toEqual({ streaming: { chunkMode: "newline" } });
    expect(result.changes).toContain(
      "Removed channels.imessage.chunkMode (channels.imessage.streaming.chunkMode already set).",
    );
  });

  it("is idempotent: a second run reports no changes", () => {
    const first = normalize({
      chunkMode: "newline",
      blockStreaming: false,
      blockStreamingCoalesce: { minChars: 10 },
    });
    expect(first.changes.length).toBeGreaterThan(0);

    const second = normalizeCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toEqual([]);
    expect(second.config).toBe(first.config);
  });
});
