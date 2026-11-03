import { getActiveSecretsRuntimeConfigSnapshot } from "openclaw/plugin-sdk/channel-secret-owner-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { GatewayRequestContext } from "openclaw/plugin-sdk/gateway-runtime";
import type { NativeGitHubReadCredentialPreparation as RepositoryReadCredentialPreparation } from "openclaw/plugin-sdk/native-github-session-read";
import { readGitHubConfig } from "./config-api.js";
import {
  prepareGitHubReadIdentity,
  resolveConfiguredGitHubToolIdentity,
} from "./tool-identity-api.js";

/** App reads require a session-owned cleanup path; native project reads remain opt-in. */
export async function prepareGatewayProjectGitHubIdentity(params: {
  agentId: string;
  assertActive: () => void;
  config: OpenClawConfig;
  context: Pick<GatewayRequestContext, "getRuntimeConfig">;
  /** Configured owner/repository to admit and issue an App token for. */
  requestedRepository?: string;
  withCredential?: <T extends { revoke?: () => Promise<void> }>(
    run: RepositoryReadCredentialPreparation<T>,
  ) => Promise<T>;
}) {
  const selected =
    resolveConfiguredGitHubToolIdentity({
      config: params.config,
      agentId: params.agentId,
      scope: "agent",
    }) ??
    resolveConfiguredGitHubToolIdentity({
      config: params.config,
      agentId: params.agentId,
      scope: "system",
    });
  const appRead = selected?.kind === "app-installation" && params.withCredential !== undefined;
  if (!appRead && readGitHubConfig(params.config).repositorySearch?.useNativeCredentials !== true) {
    return undefined;
  }
  const prepare = (
    env = process.env,
    readNativeCredential?: import("./credential-reader-api.js").GitHubCredentialReader,
    assertCredential?: () => void,
  ) =>
    prepareGitHubReadIdentity({
      config: params.config,
      sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? params.config,
      agentId: params.agentId,
      env,
      readNativeCredential,
      allowAppInstallation: appRead,
      requestedRepository: params.requestedRepository,
      getCurrentConfig: params.context.getRuntimeConfig,
      assertActive: () => {
        params.assertActive();
        assertCredential?.();
      },
      // A protected identity executable owns token refresh and revalidation.
      refresh: async () => {},
    });
  if (!appRead || !params.withCredential) {
    return await prepare();
  }
  return await params.withCredential(prepare);
}
