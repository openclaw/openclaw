import { describe, expect, it, vi } from "vitest";
import {
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
  type WizardPrompter,
} from "../../../test/helpers/extensions/setup-wizard.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { nostrPlugin } from "./channel.js";
import {
  TEST_HEX_PRIVATE_KEY,
  TEST_SETUP_RELAY_URLS,
  createConfiguredNostrCfg,
} from "./test-fixtures.js";
import { listNostrAccountIds, resolveDefaultNostrAccountId, resolveNostrAccount } from "./types.js";

const nostrConfigure = createPluginSetupWizardConfigure(nostrPlugin);

function requireNostrLooksLikeId() {
  const looksLikeId = nostrPlugin.messaging?.targetResolver?.looksLikeId;
  if (!looksLikeId) {
    throw new Error("nostr messaging.targetResolver.looksLikeId missing");
  }
  return looksLikeId;
}

function requireNostrNormalizeTarget() {
  const normalize = nostrPlugin.messaging?.normalizeTarget;
  if (!normalize) {
    throw new Error("nostr messaging.normalizeTarget missing");
  }
  return normalize;
}

function requireNostrPairingNormalizer() {
  const normalize = nostrPlugin.pairing?.normalizeAllowEntry;
  if (!normalize) {
    throw new Error("nostr pairing.normalizeAllowEntry missing");
  }
  return normalize;
}

function requireNostrResolveDmPolicy() {
  const resolveDmPolicy = nostrPlugin.security?.resolveDmPolicy;
  if (!resolveDmPolicy) {
    throw new Error("nostr security.resolveDmPolicy missing");
  }
  return resolveDmPolicy;
}

describe("nostrPlugin", () => {
  describe("meta", () => {
    it("has correct id", () => {
      expect(nostrPlugin.id).toBe("nostr");
    });

    it("has required meta fields", () => {
      expect(nostrPlugin.meta.label).toBe("Nostr");
      expect(nostrPlugin.meta.docsPath).toBe("/channels/nostr");
      expect(nostrPlugin.meta.blurb).toContain("NIP-04");
    });
  });

  describe("capabilities", () => {
    it("supports direct messages", () => {
      expect(nostrPlugin.capabilities.chatTypes).toContain("direct");
    });

    it("does not support groups (MVP)", () => {
      expect(nostrPlugin.capabilities.chatTypes).not.toContain("group");
    });

    it("does not support media (MVP)", () => {
      expect(nostrPlugin.capabilities.media).toBe(false);
    });
  });

  describe("config adapter", () => {
    it("listAccountIds returns empty array for unconfigured", () => {
      const cfg = { channels: {} };
      const ids = nostrPlugin.config.listAccountIds(cfg);
      expect(ids).toEqual([]);
    });

    it("listAccountIds returns default for configured", () => {
      const cfg = createConfiguredNostrCfg();
      const ids = nostrPlugin.config.listAccountIds(cfg);
      expect(ids).toContain("default");
    });
  });

  describe("messaging", () => {
    it("recognizes npub as valid target", () => {
      const looksLikeId = requireNostrLooksLikeId();

      expect(looksLikeId("npub1xyz123")).toBe(true);
    });

    it("recognizes hex pubkey as valid target", () => {
      const looksLikeId = requireNostrLooksLikeId();

      expect(looksLikeId(TEST_HEX_PRIVATE_KEY)).toBe(true);
    });

    it("rejects invalid input", () => {
      const looksLikeId = requireNostrLooksLikeId();

      expect(looksLikeId("not-a-pubkey")).toBe(false);
      expect(looksLikeId("")).toBe(false);
    });

    it("normalizeTarget strips spaced nostr prefixes", () => {
      const normalize = requireNostrNormalizeTarget();

      expect(normalize(`nostr:${TEST_HEX_PRIVATE_KEY}`)).toBe(TEST_HEX_PRIVATE_KEY);
      expect(normalize(`  nostr:${TEST_HEX_PRIVATE_KEY}  `)).toBe(TEST_HEX_PRIVATE_KEY);
    });
  });

  describe("outbound", () => {
    it("has correct delivery mode", () => {
      expect(nostrPlugin.outbound?.deliveryMode).toBe("direct");
    });

    it("has reasonable text chunk limit", () => {
      expect(nostrPlugin.outbound?.textChunkLimit).toBe(4000);
    });
  });

  describe("pairing", () => {
    it("has id label for pairing", () => {
      expect(nostrPlugin.pairing?.idLabel).toBe("nostrPubkey");
    });

    it("normalizes spaced nostr prefixes in allow entries", () => {
      const normalize = requireNostrPairingNormalizer();

      expect(normalize(`nostr:${TEST_HEX_PRIVATE_KEY}`)).toBe(TEST_HEX_PRIVATE_KEY);
      expect(normalize(`  nostr:${TEST_HEX_PRIVATE_KEY}  `)).toBe(TEST_HEX_PRIVATE_KEY);
    });
  });

  describe("security", () => {
    it("normalizes dm allowlist entries through the dm policy adapter", () => {
      const resolveDmPolicy = requireNostrResolveDmPolicy();

      const cfg = createConfiguredNostrCfg({
        dmPolicy: "allowlist",
        allowFrom: [`  nostr:${TEST_HEX_PRIVATE_KEY}  `],
      });
      const account = nostrPlugin.config.resolveAccount(cfg, "default");

      const result = resolveDmPolicy({ cfg, account });
      if (!result) {
        throw new Error("nostr resolveDmPolicy returned null");
      }

      expect(result.policy).toBe("allowlist");
      expect(result.allowFrom).toEqual([`  nostr:${TEST_HEX_PRIVATE_KEY}  `]);
      expect(result.normalizeEntry?.(`  nostr:${TEST_HEX_PRIVATE_KEY}  `)).toBe(
        TEST_HEX_PRIVATE_KEY,
      );
    });
  });

  describe("status", () => {
    it("has default runtime", () => {
      expect(nostrPlugin.status?.defaultRuntime).toEqual({
        accountId: "default",
        running: false,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
      });
    });
  });
});

describe("nostr setup wizard", () => {
  it("configures a private key and relay URLs", async () => {
    const prompter = createTestWizardPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Nostr private key (nsec... or hex)") {
          return TEST_HEX_PRIVATE_KEY;
        }
        if (message === "Relay URLs (comma-separated, optional)") {
          return TEST_SETUP_RELAY_URLS.join(", ");
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });

    const result = await runSetupWizardConfigure({
      configure: nostrConfigure,
      cfg: {} as OpenClawConfig,
      prompter,
      options: {},
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.nostr?.enabled).toBe(true);
    expect(result.cfg.channels?.nostr?.privateKey).toBe(TEST_HEX_PRIVATE_KEY);
    expect(result.cfg.channels?.nostr?.relays).toEqual(TEST_SETUP_RELAY_URLS);
  });
});

describe("nostr account helpers", () => {
  describe("listNostrAccountIds", () => {
    it("returns empty array when not configured", () => {
      const cfg = { channels: {} };
      expect(listNostrAccountIds(cfg)).toEqual([]);
    });

    it("returns empty array when nostr section exists but no privateKey", () => {
      const cfg = { channels: { nostr: { enabled: true } } };
      expect(listNostrAccountIds(cfg)).toEqual([]);
    });

    it("returns default when privateKey is configured", () => {
      const cfg = createConfiguredNostrCfg();
      expect(listNostrAccountIds(cfg)).toEqual(["default"]);
    });

    it("returns configured defaultAccount when privateKey is configured", () => {
      const cfg = createConfiguredNostrCfg({ defaultAccount: "work" });
      expect(listNostrAccountIds(cfg)).toEqual(["work"]);
    });
  });

  describe("resolveDefaultNostrAccountId", () => {
    it("returns default when configured", () => {
      const cfg = createConfiguredNostrCfg();
      expect(resolveDefaultNostrAccountId(cfg)).toBe("default");
    });

    it("returns default when not configured", () => {
      const cfg = { channels: {} };
      expect(resolveDefaultNostrAccountId(cfg)).toBe("default");
    });

    it("prefers configured defaultAccount when present", () => {
      const cfg = createConfiguredNostrCfg({ defaultAccount: "work" });
      expect(resolveDefaultNostrAccountId(cfg)).toBe("work");
    });
  });

  describe("resolveNostrAccount", () => {
    it("resolves configured account", () => {
      const cfg = createConfiguredNostrCfg({
        name: "Test Bot",
        relays: ["wss://test.relay"],
        dmPolicy: "pairing" as const,
      });
      const account = resolveNostrAccount({ cfg });

      expect(account.accountId).toBe("default");
      expect(account.name).toBe("Test Bot");
      expect(account.enabled).toBe(true);
      expect(account.configured).toBe(true);
      expect(account.privateKey).toBe(TEST_HEX_PRIVATE_KEY);
      expect(account.publicKey).toMatch(/^[0-9a-f]{64}$/);
      expect(account.relays).toEqual(["wss://test.relay"]);
    });

    it("resolves unconfigured account with defaults", () => {
      const cfg = { channels: {} };
      const account = resolveNostrAccount({ cfg });

      expect(account.accountId).toBe("default");
      expect(account.enabled).toBe(true);
      expect(account.configured).toBe(false);
      expect(account.privateKey).toBe("");
      expect(account.publicKey).toBe("");
      expect(account.relays).toContain("wss://relay.damus.io");
      expect(account.relays).toContain("wss://nos.lol");
    });

    it("handles disabled channel", () => {
      const cfg = createConfiguredNostrCfg({ enabled: false });
      const account = resolveNostrAccount({ cfg });

      expect(account.enabled).toBe(false);
      expect(account.configured).toBe(true);
    });

    it("handles custom accountId parameter", () => {
      const cfg = createConfiguredNostrCfg();
      const account = resolveNostrAccount({ cfg, accountId: "custom" });

      expect(account.accountId).toBe("custom");
    });

    it("handles allowFrom config", () => {
      const cfg = createConfiguredNostrCfg({
        allowFrom: ["npub1test", "0123456789abcdef"],
      });
      const account = resolveNostrAccount({ cfg });

      expect(account.config.allowFrom).toEqual(["npub1test", "0123456789abcdef"]);
    });

    it("handles invalid private key gracefully", () => {
      const cfg = {
        channels: {
          nostr: {
            privateKey: "invalid-key",
          },
        },
      };
      const account = resolveNostrAccount({ cfg });

      expect(account.configured).toBe(true);
      expect(account.publicKey).toBe("");
    });

    it("preserves all config options", () => {
      const cfg = createConfiguredNostrCfg({
        name: "Bot",
        enabled: true,
        relays: ["wss://relay1", "wss://relay2"],
        dmPolicy: "allowlist" as const,
        allowFrom: ["pubkey1", "pubkey2"],
      });
      const account = resolveNostrAccount({ cfg });

      expect(account.config).toEqual({
        privateKey: TEST_HEX_PRIVATE_KEY,
        name: "Bot",
        enabled: true,
        relays: ["wss://relay1", "wss://relay2"],
        dmPolicy: "allowlist",
        allowFrom: ["pubkey1", "pubkey2"],
      });
    });
  });
});
