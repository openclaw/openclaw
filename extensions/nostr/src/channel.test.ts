import { nip19 } from "nostr-tools";
import {
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { nostrPlugin } from "./channel.js";
import { nostrSetupPlugin } from "./channel.setup.js";
import { nostrSetupContract, nostrSetupWizard } from "./setup-surface.js";
import {
  TEST_HEX_PRIVATE_KEY,
  TEST_HEX_PUBLIC_KEY,
  TEST_SETUP_RELAY_URLS,
  buildResolvedNostrAccount,
  createConfiguredNostrCfg,
} from "./test-fixtures.js";
import { resolveNostrAccount } from "./types.js";

const npub = nip19.npubEncode(TEST_HEX_PUBLIC_KEY);
const secretCfg: OpenClawConfig = {
  channels: {
    nostr: {
      defaultAccount: "Team.A",
      privateKey: { source: "env", provider: "default", id: "MISSING_NOSTR_KEY" },
    },
  },
};

describe("nostr targets and access policy", () => {
  it.each([TEST_HEX_PUBLIC_KEY, npub, npub.toUpperCase()])(
    "resolves a prefixed public key: %s",
    (target) => {
      const to = `  nostr:${target}  `;
      const normalized = nostrPlugin.messaging?.normalizeTarget?.(to);
      expect(normalized).toBe(TEST_HEX_PUBLIC_KEY);
      expect(nostrPlugin.messaging?.targetResolver?.looksLikeId?.(to)).toBe(true);
      expect(nostrPlugin.messaging?.targetResolver?.looksLikeId?.(to, normalized)).toBe(true);
      expect(nostrPlugin.messaging?.inferTargetChatType?.({ to })).toBe("direct");
      expect(nostrPlugin.outbound?.resolveTarget?.({ cfg: {}, to, mode: "explicit" })).toEqual({
        ok: true,
        to: TEST_HEX_PUBLIC_KEY,
      });
    },
  );

  it("rejects invalid direct-message targets", () => {
    const to = "not-a-public-key";
    expect(nostrPlugin.messaging?.targetResolver?.looksLikeId?.(to)).toBe(false);
    expect(nostrPlugin.messaging?.inferTargetChatType?.({ to })).toBeUndefined();
    expect(nostrPlugin.outbound?.resolveTarget?.({ cfg: {}, to, mode: "explicit" })).toMatchObject({
      ok: false,
      error: expect.any(Error),
    });
  });

  it("explains a missing outbound target", () => {
    const result = nostrPlugin.outbound?.resolveTarget?.({ cfg: {}, mode: "explicit" });
    expect(result?.ok).toBe(false);
    if (!result || result.ok) {
      throw new Error("Expected blank Nostr target to fail");
    }
    expect(result.error.message).toBe(
      "Delivering to Nostr requires target <npub|hex pubkey|nostr:npub...>",
    );
  });

  it.each([
    { entry: `nostr:${npub}`, expected: TEST_HEX_PUBLIC_KEY },
    { entry: "nostr:*", expected: "nostr:*" },
  ])("formats $entry without widening access", ({ entry, expected }) => {
    expect(nostrPlugin.config.formatAllowFrom?.({ cfg: {}, allowFrom: [entry] })).toEqual([
      expected,
    ]);
  });

  it("normalizes pairing entries with spaced prefixes", () => {
    expect(nostrPlugin.pairing?.normalizeAllowEntry?.(`  nostr:${TEST_HEX_PUBLIC_KEY}  `)).toBe(
      TEST_HEX_PUBLIC_KEY,
    );
  });

  it("applies the configured DM policy and its allowlist normalizer", () => {
    const entry = `  nostr:${TEST_HEX_PUBLIC_KEY}  `;
    const allowFrom = [entry];
    const cfg = createConfiguredNostrCfg({ dmPolicy: "allowlist", allowFrom });
    const result = nostrPlugin.security?.resolveDmPolicy?.({
      cfg,
      account: buildResolvedNostrAccount({ config: cfg.channels.nostr }),
    });
    expect(result).toMatchObject({ policy: "allowlist", allowFrom });
    expect(result?.normalizeEntry?.(entry)).toBe(TEST_HEX_PUBLIC_KEY);
  });
});

describe("nostr accounts", () => {
  it("leaves missing credentials unconfigured with default relays", () => {
    withEnv({ NOSTR_PRIVATE_KEY: undefined }, () => {
      const cfg = { channels: { nostr: { enabled: true } } };
      expect(nostrPlugin.config.listAccountIds(cfg)).toEqual([]);
      expect(resolveNostrAccount({ cfg })).toMatchObject({
        accountId: "default",
        enabled: true,
        configured: false,
        privateKey: "",
        publicKey: "",
        relays: ["wss://relay.damus.io", "wss://nos.lol"],
      });
    });
  });

  it("resolves a disabled named account and its configured relays", () => {
    const cfg = createConfiguredNostrCfg({
      name: "Test Bot",
      defaultAccount: "work",
      enabled: false,
      relays: ["wss://test.relay"],
    });
    expect(nostrPlugin.config.listAccountIds(cfg)).toEqual(["work"]);
    expect(resolveNostrAccount({ cfg, accountId: "custom" })).toMatchObject({
      accountId: "custom",
      name: "Test Bot",
      enabled: false,
      configured: true,
      privateKey: TEST_HEX_PRIVATE_KEY,
      publicKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      relays: ["wss://test.relay"],
    });
  });

  it("leaves the public key empty for invalid credentials", () => {
    expect(
      resolveNostrAccount({ cfg: createConfiguredNostrCfg({ privateKey: "invalid-key" }) }),
    ).toMatchObject({ configured: true, publicKey: "" });
  });

  it("uses the environment key for an unconfigured default account", () => {
    withEnv({ NOSTR_PRIVATE_KEY: TEST_HEX_PRIVATE_KEY }, () => {
      expect(
        resolveNostrAccount({ cfg: { channels: { nostr: { enabled: true } } } }),
      ).toMatchObject({
        configured: true,
        privateKey: TEST_HEX_PRIVATE_KEY,
        publicKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    });
  });

  it("keeps unresolved SecretRefs configured without ambient credential fallback", () => {
    withEnv({ NOSTR_PRIVATE_KEY: TEST_HEX_PRIVATE_KEY }, () => {
      expect(nostrPlugin.config.listAccountIds(secretCfg)).toEqual(["team-a"]);
      expect(resolveNostrAccount({ cfg: secretCfg })).toMatchObject({
        accountId: "team-a",
        configured: true,
        privateKey: "",
        publicKey: "",
        config: { privateKey: secretCfg.channels?.nostr?.privateKey },
      });
    });
  });

  it("resolves SecretRefs through the lightweight setup account adapter", () => {
    withEnv({ NOSTR_PRIVATE_KEY: TEST_HEX_PRIVATE_KEY }, () => {
      expect(nostrSetupPlugin.config.defaultAccountId?.(secretCfg)).toBe("team-a");
      expect(nostrSetupPlugin.config.listAccountIds(secretCfg)).toEqual(["team-a"]);
      expect(nostrSetupPlugin.config.resolveAccount(secretCfg, undefined)).toMatchObject({
        accountId: "team-a",
        configured: true,
        privateKey: "",
      });
      expect(nostrSetupPlugin.config.resolveAccount(secretCfg, "Team.A").accountId).toBe("team-a");
    });
  });

  it("inspects a SecretRef without exposing a materialized value", () => {
    withEnv({ NOSTR_PRIVATE_KEY: undefined }, () => {
      expect(
        nostrSetupWizard.credentials?.[0]?.inspect?.({ cfg: secretCfg, accountId: "default" }),
      ).toEqual({
        accountConfigured: true,
        hasConfiguredValue: true,
        resolvedValue: undefined,
        envValue: undefined,
      });
    });
  });
});

describe("nostr setup", () => {
  it.each([
    { accountId: "default", relayUrls: TEST_SETUP_RELAY_URLS.join(", ") },
    { accountId: "work", relayUrls: "" },
  ])("configures the $accountId account through the wizard", async ({ accountId, relayUrls }) => {
    const result = await runSetupWizardConfigure({
      configure: createPluginSetupWizardConfigure(nostrPlugin),
      cfg: {},
      prompter: createTestWizardPrompter({
        text: async ({ message }) => {
          if (message === "Nostr private key (nsec... or hex)") {
            return TEST_HEX_PRIVATE_KEY;
          }
          if (message === "Relay URLs (comma-separated, optional)") {
            return relayUrls;
          }
          throw new Error(`Unexpected prompt: ${message}`);
        },
      }),
      options: {},
      accountOverrides: accountId === "default" ? undefined : { nostr: accountId },
    });
    expect(result.accountId).toBe(accountId);
    expect(result.cfg.channels?.nostr).toMatchObject({
      enabled: true,
      privateKey: TEST_HEX_PRIVATE_KEY,
    });
    if (accountId === "default") {
      expect(result.cfg.channels?.nostr?.relays).toEqual(TEST_SETUP_RELAY_URLS);
    } else {
      expect(result.cfg.channels?.nostr?.defaultAccount).toBe("work");
    }
  });

  it("uses the configured setup default when accountId is omitted", () => {
    expect(
      nostrPlugin.setupContract?.resolveAccountId?.({
        cfg: createConfiguredNostrCfg({ defaultAccount: "work" }),
        input: {},
      }),
    ).toBe("work");
  });

  it("accepts uppercase bech32 private keys in lightweight setup", () => {
    const privateKey = nip19.nsecEncode(Buffer.from(TEST_HEX_PRIVATE_KEY, "hex")).toUpperCase();
    expect(
      nostrSetupPlugin.setupContract?.validateInput?.({
        cfg: {},
        accountId: "default",
        input: { privateKey },
      }),
    ).toBeNull();
  });

  it.each([
    ["malformed nsec", "nsec1not-a-real-secret"],
    ["wrong payload length", nip19.nsecEncode(new Uint8Array(31))],
    ["zero scalar", nip19.nsecEncode(new Uint8Array(32))],
    ["curve-order scalar", "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"],
  ])("rejects %s across setup surfaces", (_label, privateKey) => {
    const input = { cfg: {}, accountId: "default", input: { privateKey } };
    const error = "Nostr private key must be valid nsec or 64-character hex.";
    expect(nostrSetupContract.validateInput?.(input)).toBe(error);
    expect(nostrSetupPlugin.setupContract?.validateInput?.(input)).toBe(error);
  });
});
