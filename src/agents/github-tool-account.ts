import { stringify as stringifyYaml } from "yaml";
import { resolveConfiguredGitHubHost } from "./github-host.js";

export type GitHubToolAccount = {
  accountId: number;
  login: string;
  avatarUrl: string | null;
};

export function managedGitHubHosts(identity: {
  login: string;
  token: string;
  host?: string;
}): string {
  return stringifyYaml({
    [identity.host ?? resolveConfiguredGitHubHost()]: {
      user: identity.login,
      oauth_token: identity.token,
      users: { [identity.login]: { oauth_token: identity.token } },
    },
  });
}
