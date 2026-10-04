import fs from "node:fs";
import path from "node:path";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withEnv, withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { resolveA2aChannelAccount } from "./accounts.js";
import { a2aChannelPlugin } from "./channel.js";
import { a2aChannelStatus } from "./status.js";

const PLACEHOLDER = "${OPENCLAW_A2A_TEST_UNSET_INBOUND}";

async function loadRuntimeConfig(
  stateDir: string,
  a2a: Record<string, unknown>,
  env: Record<string, string | undefined>,
) {
  const configPath = path.join(stateDir, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({ channels: { a2a } }));
  return withEnv({ OPENCLAW_CONFIG_PATH: configPath, ...env }, () =>
    // The default read pins the first snapshot; each case needs its own fresh load.
    getRuntimeConfig({ pin: false }),
  );
}

describe("A2A account credential resolution", () => {
  it("drops peers whose inbound token reference did not resolve", async () => {
    await withStateDirEnv("a2a-accounts-", async ({ stateDir }) => {
      const cfg = await loadRuntimeConfig(
        stateDir,
        { peers: { x: { token: PLACEHOLDER } } },
        { OPENCLAW_A2A_TEST_UNSET_INBOUND: undefined },
      );
      // The loader keeps the literal text; this is the value a caller could replay.
      expect(cfg.channels?.a2a?.peers?.x?.token).toBe(PLACEHOLDER);

      const account = resolveA2aChannelAccount({ cfg });
      expect(account.config.peers).toEqual({});
      expect(account.configured).toBe(false);
    });
  });

  it("keeps peers whose token reference resolved, and drops only the unresolved ones", async () => {
    await withStateDirEnv("a2a-accounts-", async ({ stateDir }) => {
      const cfg = await loadRuntimeConfig(
        stateDir,
        {
          peers: {
            good: { token: "${OPENCLAW_A2A_TEST_SET_INBOUND}" },
            bad: { token: PLACEHOLDER },
            "dotted.peer": { token: "${OPENCLAW_A2A_TEST_UNSET_DOTTED}" },
            mixed: { token: "prefix-${OPENCLAW_A2A_TEST_UNSET_MIXED}" },
          },
        },
        {
          OPENCLAW_A2A_TEST_SET_INBOUND: "resolved-secret-value",
          OPENCLAW_A2A_TEST_UNSET_INBOUND: undefined,
          OPENCLAW_A2A_TEST_UNSET_DOTTED: undefined,
          OPENCLAW_A2A_TEST_UNSET_MIXED: undefined,
        },
      );

      const account = resolveA2aChannelAccount({ cfg });
      expect(Object.keys(account.config.peers ?? {})).toEqual(["good"]);
      expect(account.config.peers?.good?.token).toBe("resolved-secret-value");
      expect(account.configured).toBe(true);
    });
  });

  it("keeps an escaped literal token that merely looks like a reference", async () => {
    await withStateDirEnv("a2a-accounts-", async ({ stateDir }) => {
      const cfg = await loadRuntimeConfig(
        stateDir,
        { peers: { literal: { token: "$${OPENCLAW_A2A_TEST_LITERAL}" } } },
        { OPENCLAW_A2A_TEST_LITERAL: undefined },
      );

      const account = resolveA2aChannelAccount({ cfg });
      expect(account.config.peers?.literal?.token).toBe("${OPENCLAW_A2A_TEST_LITERAL}");
      expect(account.configured).toBe(true);
    });
  });

  it("removes an unresolved outbound token but keeps the peer and its inbound token", async () => {
    await withStateDirEnv("a2a-accounts-", async ({ stateDir }) => {
      const cfg = await loadRuntimeConfig(
        stateDir,
        {
          peers: {
            hermes: {
              token: "inline-inbound-secret",
              url: "https://peer.example.test",
              outboundToken: "${OPENCLAW_A2A_TEST_UNSET_OUTBOUND}",
            },
          },
        },
        { OPENCLAW_A2A_TEST_UNSET_OUTBOUND: undefined },
      );

      const peer = resolveA2aChannelAccount({ cfg }).config.peers?.hermes;
      expect(peer?.token).toBe("inline-inbound-secret");
      expect(peer?.url).toBe("https://peer.example.test");
      expect(peer).not.toHaveProperty("outboundToken");
    });
  });

  it("leaves hand-built configs without loader facts untouched", () => {
    const account = resolveA2aChannelAccount({
      cfg: { channels: { a2a: { peers: { hermes: { token: "test-token" } } } } },
    });
    expect(account.config.peers?.hermes?.token).toBe("test-token");
    expect(account.configured).toBe(true);
  });

  it("reports which peers were withheld so status can name them", async () => {
    await withStateDirEnv("a2a-accounts-", async ({ stateDir }) => {
      const cfg = await loadRuntimeConfig(
        stateDir,
        {
          peers: {
            good: { token: "inline-secret" },
            lost: { token: PLACEHOLDER },
          },
        },
        { OPENCLAW_A2A_TEST_UNSET_INBOUND: undefined },
      );

      const account = resolveA2aChannelAccount({ cfg });
      expect(account.unresolvedPeers).toEqual(["lost"]);
      const withheld = await a2aChannelStatus.buildAccountSnapshot?.({ account, cfg });
      expect(withheld).toMatchObject({ peerCount: 1, unresolvedPeers: ["lost"] });

      const clean = await a2aChannelStatus.buildAccountSnapshot?.({
        account: resolveA2aChannelAccount({
          cfg: { channels: { a2a: { peers: { good: { token: "inline-secret" } } } } },
        }),
        cfg,
      });
      expect(clean).not.toHaveProperty("unresolvedPeers");
    });
  });

  it("keeps unresolved peers in the saved config when setup adds a peer", async () => {
    await withStateDirEnv("a2a-accounts-", async ({ stateDir }) => {
      const cfg = await loadRuntimeConfig(
        stateDir,
        {
          peers: {
            lost: {
              token: PLACEHOLDER,
              url: "https://peer.example.test",
              outboundToken: "${OPENCLAW_A2A_TEST_UNSET_OUTBOUND}",
            },
          },
        },
        { OPENCLAW_A2A_TEST_UNSET_INBOUND: undefined, OPENCLAW_A2A_TEST_UNSET_OUTBOUND: undefined },
      );

      const next = a2aChannelPlugin.setupContract?.applyAccountConfig({
        cfg,
        accountId: "default",
        input: { peerName: "fresh", peerToken: "fresh-secret-value" },
      });

      // Setup rewrites the whole peers map, so withheld peers must survive untouched.
      expect(next?.channels?.a2a?.peers?.lost).toEqual({
        token: PLACEHOLDER,
        url: "https://peer.example.test",
        outboundToken: "${OPENCLAW_A2A_TEST_UNSET_OUTBOUND}",
      });
      expect(next?.channels?.a2a?.peers?.fresh).toEqual({ token: "fresh-secret-value" });
    });
  });
});
