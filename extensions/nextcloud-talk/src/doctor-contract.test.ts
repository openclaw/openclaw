// Nextcloud Talk tests cover doctor contract plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract.js";

function talkConfig(entry: Record<string, unknown>): OpenClawConfig {
  return { channels: { "nextcloud-talk": entry } } as never;
}

describe("nextcloud-talk streaming legacy config rules", () => {
  const rootRule = legacyConfigRules.find(
    (rule) =>
      rule.path.join(".") === "channels.nextcloud-talk" && rule.message.includes("chunkMode"),
  );

  it("matches flat delivery aliases but not the nested shape", () => {
    expect(rootRule?.match?.({ chunkMode: "newline" }, {})).toBe(true);
    expect(rootRule?.match?.({ streaming: { chunkMode: "newline" } }, {})).toBe(false);
  });
});

describe("nextcloud-talk normalizeCompatibilityConfig streaming aliases", () => {
  it("moves flat delivery aliases at root and account level with root seeding", () => {
    const result = normalizeCompatibilityConfig({
      cfg: talkConfig({
        chunkMode: "newline",
        accounts: {
          home: { blockStreaming: true },
        },
      }),
    });

    const talk = result.config.channels?.["nextcloud-talk"] as unknown as Record<string, unknown>;
    expect(talk.streaming).toEqual({ chunkMode: "newline" });
    expect(talk.chunkMode).toBeUndefined();
    const home = (talk.accounts as Record<string, Record<string, unknown>>).home;
    // Account merge replaces root streaming wholesale, so the migrated account
    // object carries the inherited root chunk mode.
    expect(home?.streaming).toEqual({ chunkMode: "newline", block: { enabled: true } });
    expect(home?.blockStreaming).toBeUndefined();
  });

  it("still runs the legacy private-network migration and stays idempotent", () => {
    const first = normalizeCompatibilityConfig({
      cfg: talkConfig({ allowPrivateNetwork: true, blockStreaming: false }),
    });
    const talk = first.config.channels?.["nextcloud-talk"] as unknown as Record<string, unknown>;
    expect(talk.allowPrivateNetwork).toBeUndefined();
    expect(talk.network).toEqual({ dangerouslyAllowPrivateNetwork: true });
    expect(talk.streaming).toEqual({ block: { enabled: false } });

    const second = normalizeCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toEqual([]);
  });
});

describe("Nextcloud Talk webhook port migration", () => {
  it("preserves explicit listeners and host-only settings with the historical port", () => {
    const result = normalizeCompatibilityConfig({
      cfg: talkConfig({
        webhookHost: "127.0.0.1",
        accounts: {
          existing: { webhookPort: 8788 },
          fresh: { baseUrl: "https://cloud.example.com" },
        },
      }),
    });
    expect(result.config.channels?.["nextcloud-talk"]).toEqual({
      legacyWebhook: { port: 8788, host: "127.0.0.1" },
      accounts: {
        existing: { legacyWebhook: { port: 8788, host: "127.0.0.1" } },
        fresh: { baseUrl: "https://cloud.example.com" },
      },
    });
    expect(normalizeCompatibilityConfig({ cfg: result.config }).changes).toEqual([]);
  });

  it("keeps canonical false authoritative through plugin Doctor normalization", () => {
    const result = normalizeCompatibilityConfig({
      cfg: talkConfig({
        baseUrl: "https://cloud.example.com",
        botSecret: "test-bot-secret",
        legacyWebhook: false,
        webhookPort: 8788,
        accounts: {
          disabled: { legacyWebhook: false, webhookPort: 8789 },
          inherited: { webhookPort: 8790 },
          explicit: { legacyWebhook: { port: 8791 }, webhookPort: 8792 },
        },
      }),
    });
    for (const accountId of ["default", "disabled", "inherited"]) {
      expect(
        resolveNextcloudTalkAccount({ cfg: result.config, accountId }).config.legacyWebhook,
      ).toBe(false);
    }
    expect(
      resolveNextcloudTalkAccount({ cfg: result.config, accountId: "explicit" }).config
        .legacyWebhook,
    ).toEqual({ port: 8791 });
    expect(normalizeCompatibilityConfig({ cfg: result.config }).changes).toEqual([]);
  });
});
