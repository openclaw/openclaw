import { isDeepStrictEqual } from "node:util";
import type { GitHubIdentityFacts } from "../../packages/gateway-protocol/src/index.js";
import { getRepositoryIntegration } from "../plugins/repository-integration-runtime.js";
import {
  prepareGitHubAppInstallation,
  readGitHubAppInstallationMetadata,
} from "./github-app-installation.js";
import type { GitHubAppSelection, GitHubCredentialReader } from "./github-credential-reader.js";
import {
  resolveGitHubHost,
  resolveGitHubApiBaseUrl,
  withGitHubToken,
} from "./github-host-runtime.js";
import {
  annotateGitHubIdentityError,
  GitHubIdentityError,
  type GitHubIdentityPreparation,
} from "./github-read-identity.js";
import type { PreparedGitHubPublicationIdentity } from "./github-tool-identity.types.js";

const selections = new WeakMap<object, GitHubAppSelection>();
export function matchesAppGitHubIdentity(
  identity: PreparedGitHubPublicationIdentity,
  selection: import("../config/types.tools.js").GitHubToolIdentityConfig,
): boolean {
  const snapshot = selections.get(identity);
  return !snapshot || isDeepStrictEqual(snapshot, selection);
}

export async function prepareAppGitHubIdentity(
  params: GitHubIdentityPreparation & {
    assertCurrent?: () => void;
    allowAppInstallation?: boolean;
    requestedRepository?: string;
    readNativeCredential?: GitHubCredentialReader;
  },
  selection: GitHubAppSelection,
  source: "system-configured" | "agent-override",
  env: NodeJS.ProcessEnv,
  host: string,
  apiBaseUrl: string,
) {
  // Existing publication and background readers do not own App token cleanup.
  if (!params.allowAppInstallation) {
    throw new GitHubIdentityError("unavailable", "app-not-admitted");
  }
  const snapshot = structuredClone(selection);
  const integration = getRepositoryIntegration(params.config);
  const assertCurrent = () => {
    params.assertCurrent?.();
    params.readNativeCredential?.assertCurrent?.();
    if (
      getRepositoryIntegration(params.config) !== integration ||
      resolveGitHubHost() !== host ||
      resolveGitHubApiBaseUrl() !== apiBaseUrl ||
      !isDeepStrictEqual(selection, snapshot)
    ) {
      throw new GitHubIdentityError("changed");
    }
  };
  assertCurrent();
  let requestedSelection = selection;
  const requestedRepository = params.requestedRepository?.toLowerCase();
  if (requestedRepository !== undefined) {
    const repository = selection.app.repositories.find(
      (repo) => repo.fullName.toLowerCase() === requestedRepository,
    );
    if (!repository) {
      throw new GitHubIdentityError("unavailable", "repository-not-selected");
    }
    // Retain the complete selection above for currency checks. Only the grant
    // and broker receipt are narrowed to the repository this request reads.
    requestedSelection = { ...selection, app: { ...selection.app, repositories: [repository] } };
  }
  if (integration || process.env.FACTORY_AUTH_MODE === "github") {
    if (!params.readNativeCredential) {
      throw new GitHubIdentityError("unavailable", "native-reader-missing");
    }
    try {
      await params.readNativeCredential(env, {
        kind: "repository-admission",
        host,
        selection: requestedSelection,
      });
    } catch (error) {
      throw annotateGitHubIdentityError(error, "native-reader-failed");
    }
    assertCurrent();
  }
  const issued = await prepareGitHubAppInstallation({
    selection,
    repositories: requestedSelection.app.repositories,
    host,
    apiBaseUrl,
    assertCurrent,
  }).catch((error: unknown) => {
    throw annotateGitHubIdentityError(error, "issuer-failed");
  });
  try {
    assertCurrent();
    const prepared = Object.freeze({
      source,
      profileId: selection.profileId,
      host,
      account: issued.account,
      env: Object.freeze({
        ...withGitHubToken(env, issued.token),
        GH_HOST: host,
        OPENCLAW_GITHUB_EXECUTION_KIND: "app-installation",
      }),
      accessExpiresAtMs: issued.expiresAtMs,
      revoke: issued.revoke,
    });
    selections.set(prepared, snapshot);
    return { prepared, token: issued.token, readToken: issued.readToken, stale: undefined };
  } catch (error) {
    await issued.revoke().catch(() => {});
    throw error;
  }
}

export function configuredAppGitHubIdentityFacts(
  selection: GitHubAppSelection,
  source: "system-configured" | "agent-override",
): GitHubIdentityFacts {
  const metadata = readGitHubAppInstallationMetadata(
    selection,
    resolveGitHubHost(),
    resolveGitHubApiBaseUrl(),
  );
  return {
    source,
    credentialKind: "app-installation",
    // Status does not issue a credential; an absent observation is not a failed grant.
    credentialState: metadata ? "available" : "unverified",
    account: metadata ? { login: metadata.account.login } : null,
    gitAuthor: {
      name: selection.gitAuthor?.name ?? null,
      email: selection.gitAuthor?.email ?? null,
    },
    evidence: metadata ? "github-api" : "none",
    accessExpiresAtMs: metadata?.expiresAtMs ?? null,
    refreshState: "not_applicable",
    oauthScopes: [],
    repositoryGrants: "unknown",
  };
}

export function configuredAppGitHubOptionsIdentity(
  selection: GitHubAppSelection,
  source: "system-configured" | "agent-override",
) {
  const host = resolveGitHubHost();
  const metadata = readGitHubAppInstallationMetadata(selection, host, resolveGitHubApiBaseUrl());
  if (!metadata) {
    throw new GitHubIdentityError("unavailable");
  }
  return { source, host, account: metadata.account, stale: undefined };
}
