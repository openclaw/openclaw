import {
  ControlUiGitHubError,
  fetchGitHubApi,
  readGitHubJsonResponse,
  isRecord,
} from "./github-api.js";
import type { ControlUiGitHubPreviewIdentity } from "./preview-contract.js";
import type { GitHubTarget } from "./targets.js";

export class SessionGitHubAccessError extends ControlUiGitHubError {
  constructor(message: string) {
    super(404, message);
  }
}

/** Prepared by the host's current operator/session and selected-App admission owners. */
export type SessionGitHubReadIdentity = ControlUiGitHubPreviewIdentity & {
  host: string;
  apiBaseUrl: string;
  repository: { id: number; owner: string; repo: string };
};

export function assertSessionGitHubTarget(
  target: GitHubTarget,
  identity: SessionGitHubReadIdentity,
) {
  identity.assertSelected();
  if (
    !identity.token ||
    target.owner.toLowerCase() !== identity.repository.owner.toLowerCase() ||
    target.repo.toLowerCase() !== identity.repository.repo.toLowerCase()
  ) {
    throw new SessionGitHubAccessError("GitHub repository is outside the selected session");
  }
}

export function sessionGitHubRepositoryUrl(identity: SessionGitHubReadIdentity): string {
  return `${identity.apiBaseUrl}/repos/${encodeURIComponent(identity.repository.owner)}/${encodeURIComponent(identity.repository.repo)}`;
}

/** A rename/transfer needs a newly admitted session target, never credential forwarding. */
export function rejectSessionGitHubRedirect(): never {
  throw new SessionGitHubAccessError("GitHub repository target changed; reopen the session link");
}

export function assertSessionRepositoryUrl(raw: string, identity: SessionGitHubReadIdentity) {
  if (raw.toLowerCase() !== sessionGitHubRepositoryUrl(identity).toLowerCase()) {
    throw new SessionGitHubAccessError("GitHub response is outside the selected session");
  }
}

export async function readSessionGitHubRepository(
  identity: SessionGitHubReadIdentity,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
) {
  const value = await readGitHubJsonResponse(
    await fetchGitHubApi(
      sessionGitHubRepositoryUrl(identity),
      fetchImpl,
      identity.token,
      rejectSessionGitHubRedirect,
      identity,
      undefined,
      signal,
      undefined,
      identity.apiBaseUrl,
    ),
  );
  if (
    !isRecord(value) ||
    value.id !== identity.repository.id ||
    typeof value.full_name !== "string" ||
    value.full_name.toLowerCase() !==
      `${identity.repository.owner}/${identity.repository.repo}`.toLowerCase()
  ) {
    throw new SessionGitHubAccessError("GitHub repository no longer matches the selected session");
  }
  return identity.repository.id;
}
