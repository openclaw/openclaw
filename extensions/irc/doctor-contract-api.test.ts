import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

function ircConfig(entry: Record<string, unknown>): OpenClawConfig {
  return { channels: { irc: entry } } as never;
}

function findRule(scope = "", message = "") {
  return legacyConfigRules.find(
    (rule) => rule.path.join(".") === `channels.irc${scope}` && rule.message?.includes(message),
  );
}

describe("irc doctor compatibility contract", () => {
  it("matches flat delivery aliases at root and account level", () => {
    const rootRule = findRule();
    const accountRule = findRule(".accounts");
    expect(rootRule?.match?.({ blockStreaming: false }, {})).toBe(true);
    expect(rootRule?.match?.({ streaming: { block: { enabled: false } } }, {})).toBe(false);
    expect(accountRule?.match?.({ libera: { chunkMode: "newline" } }, {})).toBe(true);
    expect(accountRule?.match?.({ libera: { streaming: { chunkMode: "newline" } } }, {})).toBe(
      false,
    );
  });
  it("moves flat delivery aliases and seeds materialized account objects from root", () => {
    const result = normalizeCompatibilityConfig({
      cfg: ircConfig({
        blockStreaming: true,
        accounts: { libera: { chunkMode: "newline" } },
      }),
    });

    // Account merge replaces streaming wholesale; migration must carry root block settings.
    expect(result.config.channels?.irc).toEqual({
      streaming: { block: { enabled: true } },
      accounts: { libera: { streaming: { chunkMode: "newline", block: { enabled: true } } } },
    });
  });

  it("is idempotent: a second run reports no changes", () => {
    const first = normalizeCompatibilityConfig({
      cfg: ircConfig({ chunkMode: "length", blockStreamingCoalesce: { minChars: 10 } }),
    });
    expect(first.changes.length).toBeGreaterThan(0);
    const second = normalizeCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toEqual([]);
    expect(second.config).toBe(first.config);
  });
  it("flags and strips the retired key at root and account scope", () => {
    const cfg = ircConfig({
      host: "irc.libera.chat",
      mentionPatterns: ["\\bopenclaw\\b"],
      accounts: { work: { nick: "openclaw-ops", mentionPatterns: ["\\bops\\b"] } },
    });

    const rootRule = findRule("", "mentionPatterns");
    const accountRule = findRule(".accounts", "mentionPatterns");
    expect(rootRule?.match?.({ mentionPatterns: ["x"] }, {})).toBe(true);
    expect(rootRule?.match?.({ host: "irc.libera.chat" }, {})).toBe(false);
    expect(accountRule?.match?.({ work: { mentionPatterns: ["x"] } }, {})).toBe(true);
    expect(accountRule?.match?.({ work: { nick: "n" } }, {})).toBe(false);

    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.config.channels?.irc).toEqual({
      host: "irc.libera.chat",
      accounts: { work: { nick: "openclaw-ops" } },
    });
    expect(result.changes.some((change) => change.includes("mentionPatterns"))).toBe(true);
  });

  it("leaves a config without the retired key untouched", () => {
    const result = normalizeCompatibilityConfig({ cfg: ircConfig({ host: "irc.libera.chat" }) });
    expect(result.changes.some((change) => change.includes("mentionPatterns"))).toBe(false);
  });
});
