// Mattermost tests cover doctor plugin behavior.
import { describe, expect, it } from "vitest";
import { mattermostDoctor } from "./doctor.js";

function getMattermostCompatibilityNormalizer(): NonNullable<
  typeof mattermostDoctor.normalizeCompatibilityConfig
> {
  const normalize = mattermostDoctor.normalizeCompatibilityConfig;
  if (!normalize) {
    throw new Error("Expected mattermost doctor to expose normalizeCompatibilityConfig");
  }
  return normalize;
}

describe("mattermost doctor", () => {
  it("removes retired private-network config", () => {
    const normalize = getMattermostCompatibilityNormalizer();

    const result = normalize({
      cfg: {
        channels: {
          mattermost: {
            allowPrivateNetwork: true,
            network: {
              dangerouslyAllowPrivateNetwork: true,
            },
            accounts: {
              work: {
                allowPrivateNetwork: false,
                network: {
                  dangerouslyAllowPrivateNetwork: false,
                },
              },
            },
          },
        },
      } as never,
    });

    const mattermostConfig = result.config.channels?.mattermost;
    if (!mattermostConfig) {
      throw new Error("expected normalized Mattermost config");
    }
    expect(mattermostConfig.network).toBeUndefined();
    const workAccount = mattermostConfig.accounts?.work as
      | { network?: Record<string, unknown> }
      | undefined;
    if (!workAccount) {
      throw new Error("expected Mattermost work account config");
    }
    expect(workAccount.network).toBeUndefined();
    const removalReason =
      "Mattermost private-network fetch enforcement moved to proxy.enabled plus external proxy policy.";
    expect(result.changes).toEqual([
      `Removed channels.mattermost private-network config. ${removalReason}`,
      `Removed channels.mattermost.accounts.work private-network config. ${removalReason}`,
    ]);
  });
});
