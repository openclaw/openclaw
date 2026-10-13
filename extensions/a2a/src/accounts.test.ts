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
      // The adapter must hand these snapshots to the collector so `channels status` warns.
      expect(a2aChannelStatus.collectStatusIssues).toBeTypeOf("function");
      const issues = a2aChannelStatus.collectStatusIssues?.([
        { accountId: "default", enabled: true, configured: true, ...withheld },
      ]);
      expect(issues?.[0]?.message).toContain("lost");

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
