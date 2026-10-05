import { isDeepStrictEqual } from "node:util";
import type { GitHubIdentityFacts } from "../../packages/gateway-protocol/src/index.js";
import {
  prepareGitHubAppInstallation,
  type GitHubAppSelection,
} from "./github-app-installation.js";
import {
  resolveGitHubHost,
  resolveGitHubApiBaseUrl,
  withGitHubToken,
} from "./github-host-runtime.js";
import { measureGitHubIdentityPreparation } from "./github-identity-preparation-timing.js";
import {
  GitHubIdentityError,
  startGitHubIdentityOperation,
  type GitHubIdentityPreparation,
  type GitHubReadIdentityStarter,
} from "./github-read-identity.js";
import type { PreparedGitHubPublicationIdentity } from "./github-tool-identity.js";

const preparedSelections = new WeakMap<PreparedGitHubPublicationIdentity, GitHubAppSelection>();
export function matchesAppGitHubIdentity(
  identity: PreparedGitHubPublicationIdentity,
  selection: import("../config/types.tools.js").GitHubToolIdentityConfig,
): boolean {
  const retained = preparedSelections.get(identity);
  return !retained || isDeepStrictEqual(selection, retained);
}

export async function prepareAppGitHubIdentity(
  params: GitHubIdentityPreparation & {
    assertCurrent?: () => void;
    startCurrent?: GitHubReadIdentityStarter;
  },
  selection: GitHubAppSelection,
  source: "system-configured" | "agent-override",
  env: NodeJS.ProcessEnv,
  host: string,
  apiBaseUrl: string,
) {
  const snapshot = structuredClone(selection);
  const assertCurrent = () => {
    params.assertCurrent?.();
    if (
      host !== resolveGitHubHost() ||
      apiBaseUrl !== resolveGitHubApiBaseUrl() ||
      !isDeepStrictEqual(selection, snapshot)
    ) {
      throw new GitHubIdentityError("changed");
    }
  };
  assertCurrent();
  if (process.env.FACTORY_AUTH_MODE === "github") {
    const reader = params.readNativeCredential;
    if (!reader) {
      throw new GitHubIdentityError("unavailable");
    }
    await measureGitHubIdentityPreparation(params.observePreparation, "repository_admission", () =>
      Promise.resolve(
        startGitHubIdentityOperation(
          () => reader(env, { kind: "repository-admission", host, selection }),
          params,
        ),
      ),
    );
    assertCurrent();
  }
  const issued = await measureGitHubIdentityPreparation(
    params.observePreparation,
    "app_installation",
    () => prepareGitHubAppInstallation({ selection, host, apiBaseUrl, assertCurrent }),
  );
  assertCurrent();
  const prepared: PreparedGitHubPublicationIdentity = Object.freeze({
    source,
    profileId: selection.profileId,
    host,
    account: issued.account,
    env: Object.freeze(withGitHubToken(env, issued.token)),
    accessExpiresAtMs: issued.expiresAtMs,
  });
  preparedSelections.set(prepared, snapshot);
  return { prepared, token: issued.token, readToken: issued.readToken };
}

export async function appGitHubIdentityFacts(
  selection: GitHubAppSelection,
  source: "system-configured" | "agent-override",
  assertCurrent: () => void,
): Promise<GitHubIdentityFacts> {
  const issued = await prepareGitHubAppInstallation({
    selection,
    host: resolveGitHubHost(),
    apiBaseUrl: resolveGitHubApiBaseUrl(),
    assertCurrent,
  });
  assertCurrent();
  return {
    source,
    credentialKind: "app-installation",
    credentialState: "available",
    account: { login: issued.account.login },
    gitAuthor: {
      name: selection.gitAuthor?.name ?? null,
      email: selection.gitAuthor?.email ?? null,
    },
    evidence: "github-api",
    accessExpiresAtMs: issued.expiresAtMs,
    refreshState: "available",
    oauthScopes: [],
    repositoryGrants: "unknown",
    appInstallation: issued.facts,
  };
}
