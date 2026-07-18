// Googlechat tests cover accounts plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { listEnabledGoogleChatAccounts, resolveGoogleChatAccount } from "./accounts.js";
import { googlechatMessageActions } from "./actions.js";

const unresolvedRef = {
  source: "env",
  provider: "default",
  id: "OPENCLAW_TEST_MISSING_GOOGLE_CHAT_SERVICE_ACCOUNT",
} as const;

function buildTwoAccountCfg(): OpenClawConfig {
  return {
    channels: {
      googlechat: {
        enabled: true,
        accounts: {
          broken: { enabled: true, serviceAccount: unresolvedRef },
          healthy: {
            enabled: true,
            serviceAccount:
              '{"client_email":"proof@example.iam.gserviceaccount.com","private_key":"proof-key"}',
          },
        },
      },
    },
  } as OpenClawConfig;
}

describe("googlechat accounts with an unresolved SecretRef", () => {
  it("keeps healthy accounts visible in enumeration instead of throwing", () => {
    const accounts = listEnabledGoogleChatAccounts(buildTwoAccountCfg());
    const broken = accounts.find((account) => account.accountId === "broken");
    const healthy = accounts.find((account) => account.accountId === "healthy");
    expect(healthy?.credentialSource).toBe("inline");
    expect(broken?.credentialSource).toBe("none");
  });

  it("still advertises send through message action discovery", () => {
    expect(googlechatMessageActions.describeMessageTool?.({ cfg: buildTwoAccountCfg() })).toEqual({
      actions: ["send"],
    });
  });

  it("keeps strict resolution throwing for direct account use", () => {
    expect(() =>
      resolveGoogleChatAccount({ cfg: buildTwoAccountCfg(), accountId: "broken" }),
    ).toThrow(/unresolved SecretRef/);
  });
});
