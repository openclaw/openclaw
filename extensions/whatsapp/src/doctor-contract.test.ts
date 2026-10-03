// Whatsapp tests cover doctor contract plugin behavior.
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listWhatsAppAccountIds, resolveDefaultWhatsAppAccountId } from "./account-ids.js";
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

describe("whatsapp acknowledgement legacy config rules", () => {
  it("detects root and account acknowledgement blocks", () => {
    const rootRule = legacyConfigRules.find(
      (rule) => rule.path.join(".") === "channels.whatsapp.ackReaction",
    );
    const accountRule = legacyConfigRules.find(
      (rule) =>
        rule.path.join(".") === "channels.whatsapp.accounts" &&
        rule.message.includes("ackReaction"),
    );

    expect(rootRule).toBeDefined();
    expect(accountRule?.match?.({ work: { ackReaction: { emoji: "👀" } } }, {})).toBe(true);
    expect(accountRule?.match?.({ work: { reactionLevel: "ack" } }, {})).toBe(false);
  });
});

it("removes retired exposeErrorText at root and account level", () => {
  const result = normalizeCompatibilityConfig({
    cfg: whatsappConfig({ exposeErrorText: true, accounts: { work: { exposeErrorText: false } } }),
  });
  expect(result.config.channels?.whatsapp).toEqual({ accounts: { work: {} } });
  expect(result.changes).toContain("Removed retired channels.whatsapp.exposeErrorText.");
  expect(result.changes).toContain(
    "Removed retired channels.whatsapp.accounts.work.exposeErrorText.",
  );
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

  it("seeds named accounts from accounts.default over root (layered inheritance)", () => {
    const result = normalizeCompatibilityConfig({
      cfg: whatsappConfig({
        chunkMode: "length",
        accounts: {
          default: { blockStreaming: true },
          work: { chunkMode: "newline" },
        },
      }),
    });

    const whatsapp = result.config.channels?.whatsapp as unknown as Record<string, unknown>;
    const accounts = whatsapp.accounts as Record<string, Record<string, unknown>>;
    expect(whatsapp.streaming).toEqual({ chunkMode: "length" });
    expect(accounts.default?.streaming).toEqual({
      chunkMode: "length",
      block: { enabled: true },
    });
    // The old flat keys resolved per key across named > accounts.default >
    // root, so the materialized work object must inherit the default
    // account's block setting, not just the root chunk mode.
    expect(accounts.work?.streaming).toEqual({
      chunkMode: "newline",
      block: { enabled: true },
    });

    const second = normalizeCompatibilityConfig({ cfg: result.config });
    expect(second.changes).toEqual([]);
  });

  it("resolves the default account case-insensitively when seeding named accounts", () => {
    // resolveAccountEntry matches account keys case-insensitively, so
    // `accounts.Default` is the runtime default account too.
    const result = normalizeCompatibilityConfig({
      cfg: whatsappConfig({
        accounts: {
          Default: { blockStreaming: true },
          work: { chunkMode: "newline" },
        },
      }),
    });

    const whatsapp = result.config.channels?.whatsapp as unknown as Record<string, unknown>;
    const accounts = whatsapp.accounts as Record<string, Record<string, unknown>>;
    expect(accounts.work?.streaming).toEqual({
      chunkMode: "newline",
      block: { enabled: true },
    });
  });

  it("keeps global ackReaction canonical while migrating streaming aliases", () => {
    const first = normalizeCompatibilityConfig({
      cfg: {
        messages: { ackReaction: "👀" },
        channels: { whatsapp: { blockStreaming: true } },
      } as never,
    });
    const whatsapp = first.config.channels?.whatsapp as unknown as Record<string, unknown>;
    expect(whatsapp.ackReaction).toBeUndefined();
    expect(first.config.messages?.ackReaction).toBe("👀");
    expect(whatsapp.streaming).toEqual({ block: { enabled: true } });

    const second = normalizeCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toEqual([]);
  });
});

describe("WhatsApp Doctor account routing warning", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let oauthDir: string;
  beforeEach(() => {
    oauthDir = tempDirs.make("whatsapp-doctor-routing-");
    vi.stubEnv("OPENCLAW_OAUTH_DIR", oauthDir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const ambiguousConfig = (): OpenClawConfig =>
    whatsappConfig({
      dmPolicy: "pairing",
      accounts: {
        default: { dmPolicy: "allowlist", allowFrom: ["+15550001111"], groupPolicy: "disabled" },
        work: { authDir: "/synthetic/work" },
        "123": { authDir: "/synthetic/123", dmPolicy: "disabled" },
      },
    });

  it.each([
    { defaultAccount: undefined, selected: "default", suggested: "123" },
    { defaultAccount: "work", selected: "work", suggested: "work" },
  ])(
    "warns without changing the configured route ($selected)",
    ({ defaultAccount, selected, suggested }) => {
      const cfg = ambiguousConfig();
      if (defaultAccount) {
        cfg.channels!.whatsapp!.defaultAccount = defaultAccount;
      }
      const before = structuredClone(cfg);
      const first = normalizeCompatibilityConfig({ cfg });
      expect(first.config).toEqual(before);
      expect(cfg).toEqual(before);
      expect(first.changes).toEqual([]);
      expect(listWhatsAppAccountIds(first.config)).toEqual(["123", "default", "work"]);
      expect(resolveDefaultWhatsAppAccountId(first.config)).toBe(selected);
      expect(first.warnings).toEqual([
        expect.stringContaining("may be a leftover of an earlier Doctor migration"),
      ]);
      expect(first.warnings?.[0]).toContain(
        `Unqualified WhatsApp operations currently select "${selected}"`,
      );
      expect(first.warnings?.[0]).toContain(
        `openclaw config set channels.whatsapp.defaultAccount '"${suggested}"' --strict-json`,
      );
      expect(first.warnings?.[0]).toContain(
        "openclaw channels remove --channel whatsapp --account default --delete",
      );
      expect(first.warnings?.[0]).toContain("preserve any shared policy you still need");
      expect(
        legacyConfigRules.some(
          (rule) =>
            rule.path.join(".") === "channels.whatsapp" &&
            rule.match?.(cfg.channels?.whatsapp, cfg),
        ),
      ).toBe(false);
      expect(normalizeCompatibilityConfig({ cfg: first.config })).toEqual(first);
    },
  );

  it("suggests a valid named account rather than an invalid config key", () => {
    const cfg = whatsappConfig({
      accounts: {
        default: { dmPolicy: "pairing" },
        "invalid'account": {},
        work: { authDir: "/synthetic/work" },
      },
    });
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.warnings).toEqual([
      expect.stringContaining(
        `openclaw config set channels.whatsapp.defaultAccount '"work"' --strict-json`,
      ),
    ]);
    expect(result.warnings?.[0]).not.toContain("invalid'account");
  });

  it.each([
    "authDir",
    "name",
    "enabled",
    "defaultAccount",
    "binding",
    "bindingAlias",
    "rootAuth",
    "onlyDefault",
    "defaultAlias",
  ])("does not flag an explicitly configured default: %s", (kind) => {
    const cfg = ambiguousConfig();
    const channel = cfg.channels?.whatsapp;
    if (!channel?.accounts?.default) {
      throw new Error("Expected the ambiguous WhatsApp fixture to contain a default account");
    }
    const defaultAccount = channel.accounts.default;
    if (kind === "authDir") {
      defaultAccount.authDir = "/synthetic/default";
    }
    if (kind === "name") {
      defaultAccount.name = "Personal";
    }
    if (kind === "enabled") {
      defaultAccount.enabled = false;
    }
    if (kind === "defaultAccount") {
      channel.defaultAccount = "default";
    }
    if (kind === "defaultAlias") {
      channel.defaultAccount = " Default ";
    }
    if (kind === "rootAuth") {
      Object.assign(channel, { authDir: "/synthetic/root" });
    }
    if (kind === "binding" || kind === "bindingAlias") {
      cfg.bindings = [
        {
          agentId: "main",
          match: {
            channel: kind === "bindingAlias" ? " WhatsApp " : "whatsapp",
            accountId: "default",
          },
        },
      ];
    }
    if (kind === "onlyDefault") {
      channel.accounts = { default: defaultAccount };
    }
    expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
  });

  it("preserves the account when credential inspection fails", () => {
    const cfg = ambiguousConfig();
    vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
  });

  it.each(["creds.json", "creds.json.bak", "session-test.json"])(
    "preserves default credential evidence: %s",
    (file) => {
      for (const directory of [oauthDir, path.join(oauthDir, "whatsapp", "default")]) {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, file), "synthetic");
        const cfg = ambiguousConfig();
        expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
        fs.unlinkSync(path.join(directory, file));
      }
    },
  );
});
