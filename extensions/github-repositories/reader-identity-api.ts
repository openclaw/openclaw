import { getActiveSecretsRuntimeConfigSnapshot } from "openclaw/plugin-sdk/channel-secret-owner-runtime";
import type {
  GatewayRequestHandlerOptions,
  GatewayRequestContext,
} from "openclaw/plugin-sdk/gateway-runtime";
import { isBundledPluginEnabled } from "openclaw/plugin-sdk/plugin-config-runtime";
import { requestCurrentGitHubOAuthRefresh } from "./account-runtime-api.js";
import { resolveConfiguredGitHubHost } from "./host-api.js";
import {
  GitHubIdentityError,
  prepareGitHubReadIdentity,
  resolveConfiguredGitHubToolIdentity,
} from "./tool-identity-api.js";

/** UI and agent readers share selection; each caller supplies its own live authority. */
export async function prepareGitHubReaderIdentity(
  context: GatewayRequestContext,
  agentId: string,
  assertActive: () => void,
  requestedRepository?: string,
) {
  const config = context.getRuntimeConfig();
  const configuredIdentity = () => {
    const current = context.getRuntimeConfig();
    if (
      !isBundledPluginEnabled(current, "github-repositories") ||
      resolveConfiguredGitHubHost(current) !== "github.com"
    ) {
      return undefined;
    }
    return (
      resolveConfiguredGitHubToolIdentity({ config: current, agentId, scope: "agent" }) ??
      resolveConfiguredGitHubToolIdentity({ config: current, agentId, scope: "system" })
    );
  };
  assertActive();
  // Without a managed selection, retain service/env/anonymous access without
  // probing native gh. Both paths must still own the selection at delivery.
  const identity = configuredIdentity()
    ? await prepareGitHubReadIdentity({
        config,
        sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
        agentId,
        allowStale: true,
        allowAppInstallation: requestedRepository !== undefined,
        requestedRepository,
        getCurrentConfig: () => context.getRuntimeConfig(),
        assertActive: () => {
          assertActive();
          if (!configuredIdentity()) {
            throw new GitHubIdentityError("changed");
          }
        },
        refresh: () => requestCurrentGitHubOAuthRefresh(agentId),
      })
    : undefined;
  return {
    identity,
    assertSelected:
      identity?.assertSelected ??
      (() => {
        assertActive();
        if (configuredIdentity()) {
          throw new GitHubIdentityError("changed");
        }
      }),
  };
}

export class GitHubReadRequestInactiveError extends Error {
  constructor() {
    super("GitHub request is no longer active. Try again.");
  }
}

export async function prepareControlUiGitHubIdentity(
  { context, client, signal, hasCurrentClientAuthority }: GatewayRequestHandlerOptions,
  agentId: string,
  requestedRepository?: string,
) {
  // Nested plugin requests may decorate the client; transport authority retains its owner.
  const assertActive = () => {
    if (
      signal?.aborted ||
      (hasCurrentClientAuthority
        ? !hasCurrentClientAuthority()
        : client?.connId &&
          !context.getClientConnIds?.((current) => current === client).has(client.connId))
    ) {
      throw new GitHubReadRequestInactiveError();
    }
  };
  return prepareGitHubReaderIdentity(context, agentId, assertActive, requestedRepository);
}
