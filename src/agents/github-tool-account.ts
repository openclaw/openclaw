import { stringify as stringifyYaml } from "yaml";
import { GITHUB_PUBLIC_HOST } from "./github-host.js";

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
    [identity.host ?? GITHUB_PUBLIC_HOST]: {
      user: identity.login,
      oauth_token: identity.token,
      users: { [identity.login]: { oauth_token: identity.token } },
    },
  });
}
