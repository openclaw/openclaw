import fs from "node:fs/promises";
import { root as fsRoot } from "@openclaw/fs-safe/root";
import { stringify as stringifyYaml } from "yaml";
import { notifyManagedGitHubProfileChanged } from "./github-managed-profile-events.js";
import { managedGitHubHosts } from "./github-tool-account.js";
export {
  notifyManagedGitHubProfileChanged,
  onManagedGitHubProfileChanged,
} from "./github-managed-profile-events.js";

export type ManagedGitHubCredentialIssuer = { host: string; apiBaseUrl: string };

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
    ...(params.host ? { GH_HOST: params.host } : {}),
    ...(gitConfigEntries.length > 0
      ? { GIT_CONFIG_COUNT: String(gitConfigEntries.length), ...gitConfigEnv }
      : {}),
    ...(author?.name ? { GIT_AUTHOR_NAME: author.name, GIT_COMMITTER_NAME: author.name } : {}),
    ...(author?.email ? { GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_EMAIL: author.email } : {}),
  };
}

/** Write gh's external file contract without touching its OS keyring or verifying again. */
export async function writeManagedGitHubProfileFiles(
  profileDir: string,
  identity: { login: string; token: string; host?: string },
  options?: { assertCurrent: () => void },
): Promise<void> {
  options?.assertCurrent();
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  options?.assertCurrent();
  await fs.chmod(profileDir, 0o700);
  options?.assertCurrent();
  const profile = await fsRoot(profileDir, { mode: 0o600, mkdir: false, durable: false });
  await profile.write("config.yml", stringifyYaml({ version: "1" }), {
    assertBeforeMutation: options?.assertCurrent,
  });
  await profile.write("hosts.yml", managedGitHubHosts(identity), {
    assertBeforeMutation: options?.assertCurrent,
  });
  options?.assertCurrent();
  notifyManagedGitHubProfileChanged(profileDir);
}
