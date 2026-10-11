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

  it.each(["bindingAlias", "onlyDefault"])(
    "does not flag an explicitly configured default: %s",
    (kind) => {
      const cfg = ambiguousConfig();
      const channel = cfg.channels?.whatsapp;
      if (!channel?.accounts?.default) {
        throw new Error("Expected the ambiguous WhatsApp fixture to contain a default account");
      }
      const defaultAccount = channel.accounts.default;
      if (kind === "bindingAlias") {
        cfg.bindings = [
          {
            agentId: "main",
            match: {
              channel: " WhatsApp ",
              accountId: "default",
            },
          },
        ];
      }
      if (kind === "onlyDefault") {
        channel.accounts = { default: defaultAccount };
      }
      expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
    },
  );

  it("preserves the account when credential inspection fails", () => {
    const cfg = ambiguousConfig();
    vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
  });

  it.each(["session-test.json"])("preserves default credential evidence: %s", (file) => {
    for (const directory of [oauthDir, path.join(oauthDir, "whatsapp", "default")]) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, file), "synthetic");
      const cfg = ambiguousConfig();
      expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
      fs.unlinkSync(path.join(directory, file));
    }
  });
});
