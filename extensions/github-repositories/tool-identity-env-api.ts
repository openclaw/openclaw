import { prepareExecutionEnvironmentExclusions } from "openclaw/plugin-sdk/channel-secret-owner-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { GitHubToolIdentityConfig } from "./config-api.js";
import { GITHUB_PUBLIC_HOST } from "./host-api.js";
import { CLEARED_GITHUB_CREDENTIALS } from "./host-runtime-api.js";
import type { PreparedGitHubToolEnvironment } from "./tool-identity.types-api.js";

export const AGENT_GIT_CONFIG_PARAMETERS = "'maintenance.auto=false' 'gc.auto=0'";

export function managedGitHubIdentityEnvironment(params: {
  profileDir: string;
  host?: string;
  gitAuthor?: { name?: string; email?: string };
  gitConfig?: readonly (readonly [string, string])[];
}): Readonly<Record<string, string> & { GH_CONFIG_DIR: string }> {
  const author = params.gitAuthor;
  const gitConfigEntries = [
    ...(params.gitConfig ?? []),
    ...Object.entries({
      ...(author?.name ? { "user.name": author.name } : {}),
      ...(author?.email ? { "user.email": author.email } : {}),
    }),
  ];
  const gitConfigEnv = Object.fromEntries(
    gitConfigEntries.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  );
  return {
    GH_CONFIG_DIR: params.profileDir,
    GH_HOST: params.host ?? GITHUB_PUBLIC_HOST,
    ...(gitConfigEntries.length > 0
      ? { GIT_CONFIG_COUNT: String(gitConfigEntries.length), ...gitConfigEnv }
      : {}),
    ...(author?.name ? { GIT_AUTHOR_NAME: author.name, GIT_COMMITTER_NAME: author.name } : {}),
    ...(author?.email ? { GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_EMAIL: author.email } : {}),
  };
}

export function applyManagedGitHubIdentityEnvironment(
  env: NodeJS.ProcessEnv | undefined,
  overlay: PreparedGitHubToolEnvironment,
): NodeJS.ProcessEnv {
  return {
    ...(env ?? process.env),
    ...Object.fromEntries(Object.keys(overlay.credentialScrubEnv).map((name) => [name, undefined])),
    ...overlay.localIdentityEnv,
  };
}

export function githubCredentialEnvironmentExclusions(
  params: { config: OpenClawConfig; sourceConfig?: OpenClawConfig; env?: NodeJS.ProcessEnv },
  selected?: GitHubToolIdentityConfig,
) {
  const exclusions = prepareExecutionEnvironmentExclusions({
    config: params.sourceConfig ?? params.config,
    env: params.env,
  });
  return {
    credentialScrubEnv: {
      ...(selected ? CLEARED_GITHUB_CREDENTIALS : {}),
      ...exclusions?.credentialScrubEnv,
    },
    excludedStoreNames: exclusions?.excludedStoreNames ?? [],
  };
}
