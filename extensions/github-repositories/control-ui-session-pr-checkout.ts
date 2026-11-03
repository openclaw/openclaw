import { parseGitHubRemoteUrl } from "./remote-api.js";

export type GitHubCheckoutContext = {
  host?: string;
  owner: string;
  repo: string;
  branch: string | null;
  root?: string;
  defaultBranch?: string;
  forkHeadCandidates?: Array<{ owner: string; repo: string }>;
};

export function gitHubCheckoutContext(
  facts: {
    originUrl: string;
    branch: string | null;
    root?: string;
    defaultBranch?: string;
    forkHeadCandidates?: Array<{ owner: string; repo: string }>;
  } | null,
  host = "github.com",
): GitHubCheckoutContext | null {
  if (!facts) {
    return null;
  }
  const publicRemote = parseGitHubRemoteUrl(facts.originUrl);
  const remote = publicRemote ?? parseGitHubRemoteUrl(facts.originUrl, host);
  if (!remote) {
    return null;
  }
  return {
    ...remote,
    ...(!publicRemote ? { host } : {}),
    branch: facts.branch,
    ...(facts.root ? { root: facts.root } : {}),
    ...(facts.defaultBranch ? { defaultBranch: facts.defaultBranch } : {}),
    ...(facts.forkHeadCandidates ? { forkHeadCandidates: facts.forkHeadCandidates } : {}),
  };
}
