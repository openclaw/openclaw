import fs from "node:fs";
import path from "node:path";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withEnv, withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import { resolveA2aChannelAccount } from "./accounts.js";
import { a2aChannelPlugin } from "./channel.js";

const PLACEHOLDER = "${OPENCLAW_A2A_TEST_UNSET_INBOUND}";

function withPeers(
  peers: Record<string, unknown>,
  run: (cfg: ReturnType<typeof getRuntimeConfig>) => void | Promise<void>,
) {
  return withStateDirEnv("a2a-accounts-", async ({ stateDir }) => {
    const configPath = path.join(stateDir, "openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify({ channels: { a2a: { peers } } }));
    const cfg = withEnv(
      {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_A2A_TEST_LITERAL: undefined,
        OPENCLAW_A2A_TEST_UNSET_INBOUND: undefined,
        OPENCLAW_A2A_TEST_UNSET_OUTBOUND: undefined,
      },
      // The default read pins the first snapshot; each case needs its own fresh load.
      () => getRuntimeConfig({ pin: false }),
    );
    await run(cfg);
  });
}

it("keeps an escaped literal token that merely looks like a reference", async () => {
  await withPeers({ literal: { token: "$${OPENCLAW_A2A_TEST_LITERAL}" } }, (cfg) => {
    const account = resolveA2aChannelAccount({ cfg });
    expect(account.config.peers?.literal?.token).toBe("${OPENCLAW_A2A_TEST_LITERAL}");
    expect(account.configured).toBe(true);
  });
});

it("reports which peers were withheld so status can name them", async () => {
  const good = { token: "inline-secret" };
  await withPeers({ good, lost: { token: PLACEHOLDER } }, async (cfg) => {
    const account = resolveA2aChannelAccount({ cfg });
    expect(account.unresolvedPeers).toEqual(["lost"]);
    const withheld = await a2aChannelPlugin.status?.buildAccountSnapshot?.({ account, cfg });
    expect(withheld).toMatchObject({ peerCount: 1, unresolvedPeers: ["lost"] });
    const issues = a2aChannelPlugin.status?.collectStatusIssues?.([
      { accountId: "default", enabled: true, configured: true, ...withheld },
    ]);
    expect(issues?.[0]?.message).toContain("lost");

    const clean = await a2aChannelPlugin.status?.buildAccountSnapshot?.({
      account: resolveA2aChannelAccount({ cfg: { channels: { a2a: { peers: { good } } } } }),
      cfg,
    });
    expect(clean).not.toHaveProperty("unresolvedPeers");
  });
});

it("keeps unresolved peers in the saved config when setup adds a peer", async () => {
  const lost = {
    token: PLACEHOLDER,
    url: "https://peer.example.test",
    outboundToken: "${OPENCLAW_A2A_TEST_UNSET_OUTBOUND}",
  };
  await withPeers({ lost }, (cfg) => {
    const next = a2aChannelPlugin.setupContract?.applyAccountConfig({
      cfg,
      accountId: "default",
      input: { peerName: "fresh", peerToken: "fresh-secret-value" },
    });

    expect(next?.channels?.a2a?.peers?.lost).toEqual(lost);
    expect(next?.channels?.a2a?.peers?.fresh).toEqual({ token: "fresh-secret-value" });
  });
});
