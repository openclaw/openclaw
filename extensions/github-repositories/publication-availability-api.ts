import type { GitHubPublicationPublisher } from "@openclaw/gateway-protocol";
import { getActiveSecretsRuntimeConfigSnapshot } from "openclaw/plugin-sdk/channel-secret-owner-runtime";
import { readRuntimeConfig as getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { requestCurrentGitHubOAuthRefresh } from "./account-runtime-api.js";
import {
  rejectGitHubPublicationSelection,
  type GitHubPublicationPreparation,
} from "./publication-failure-api.js";
import {
  matchesPreparedGitHubPublicationIdentity,
  prepareGitHubPublicationIdentity,
  prepareGitHubPublicationOptionsIdentity,
  type PreparedGitHubPublicationIdentity,
} from "./tool-identity-api.js";

function publicationConfigSnapshot() {
  const active = getActiveSecretsRuntimeConfigSnapshot();
  if (active) {
    return active;
  }
  const config = getRuntimeConfig();
  return { config, sourceConfig: config };
}

export function assertExpectedSharedGitHubPublisher(
  expected: GitHubPublicationPublisher | undefined,
  actual: GitHubPublicationPublisher,
  preparation?: GitHubPublicationPreparation,
): void {
  if (
    actual.source === "personal" ||
    (expected &&
      (expected.source !== actual.source ||
        expected.accountId !== actual.accountId ||
        expected.login.toLowerCase() !== actual.login.toLowerCase()))
  ) {
    rejectGitHubPublicationSelection(
      "GitHub publication identity changed; review the current shared account and try again.",
      preparation,
    );
  }
}

export function currentGitHubPublicationConfig() {
  return publicationConfigSnapshot().config;
}

export async function prepareCurrentGitHubPublicationIdentity(
  agentId: string,
  assertCurrent?: () => void,
): Promise<PreparedGitHubPublicationIdentity> {
  assertCurrent?.();
  await requestCurrentGitHubOAuthRefresh(agentId);
  assertCurrent?.();
  const snapshot = publicationConfigSnapshot();
  return await prepareGitHubPublicationIdentity({
    config: snapshot.config,
    sourceConfig: snapshot.sourceConfig,
    agentId,
    assertCurrent,
  });
}

export async function prepareCurrentGitHubPublicationOptionsIdentity(
  agentId: string,
  assertCurrent?: () => void,
) {
  assertCurrent?.();
  await requestCurrentGitHubOAuthRefresh(agentId);
  assertCurrent?.();
  const snapshot = publicationConfigSnapshot();
  return await prepareGitHubPublicationOptionsIdentity({
    config: snapshot.config,
    sourceConfig: snapshot.sourceConfig,
    agentId,
    assertCurrent,
  });
}

export function matchesCurrentGitHubPublicationIdentity(params: {
  agentId: string;
  identity: PreparedGitHubPublicationIdentity;
}): boolean {
  return matchesPreparedGitHubPublicationIdentity({
    config: currentGitHubPublicationConfig(),
    ...params,
  });
}
