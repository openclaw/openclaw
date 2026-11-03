import type { SessionGitHubPullRequestInspectResult } from "@openclaw/gateway-protocol";
import {
  type NativeGitHubPublicationProvider as RepositoryPublicationProvider,
  type NativeGitHubPullRequestBinding as SessionGitHubPullRequestBinding,
  NativeGitHubPublicationRequesterUnavailableError as RepositoryPublicationRequesterUnavailableError,
  nativeGitHubPublicationBaseBranch as parseGitHubPublicationBaseBranch,
  NativeGitHubPublicationWorkspaceChangedError as RepositoryPublicationWorkspaceChangedError,
} from "openclaw/plugin-sdk/native-github-publication-host";
import { resolveGitHubHost } from "./host-runtime-api.js";
import { GitHubPublicationBranchChangedError } from "./publication-failure-api.js";
import { requireGitHubPublicationCommand } from "./publication-git-transport-api.js";
import { inspectOwnGitHubPullRequest } from "./publication-inspect-api.js";
import { assertExistingPullRequestWriteAccess } from "./publication-pr-preflight-api.js";
import { readGitHubPublisher } from "./publication-publisher-api.js";
import { parseGitHubRemoteUrl } from "./remote-api.js";
import { resolveGitHubRepositoryTarget } from "./repository-target-api.js";
import type { PreparedGitHubPublicationIdentity } from "./tool-identity-api.js";

/** Resolve the authoritative Git remote and GitHub PR parent with the selected publisher. */
export async function prepareGitHubPublicationTarget(params: {
  source: {
    originUrl: string;
    branch: string;
    baseRef: string;
    pullRequest?: SessionGitHubPullRequestBinding;
  };
  identity: PreparedGitHubPublicationIdentity;
  assertCurrent: () => void;
}) {
  const { source, assertCurrent } = params;
  const githubHost = params.identity.host ?? resolveGitHubHost();
  if (source.pullRequest) {
    const pr = source.pullRequest;
    if (
      pr.host !== githubHost ||
      !pr.preparedHeadCommit ||
      pr.preparedHeadCommit !== pr.head.commit
    ) {
      throw new RepositoryPublicationWorkspaceChangedError(
        "The original PR preparation is incomplete or its publisher host changed.",
      );
    }
    return {
      pushRepository: pr.head.repository,
      repository: pr.base.repository,
      branch: pr.head.branch,
      baseBranch: pr.base.branch,
      pushOwner: pr.head.repository.split("/")[0]!,
      githubHost,
    };
  }
  const remote = parseGitHubRemoteUrl(source.originUrl, githubHost);
  if (
    !remote ||
    !/^[A-Za-z0-9_.-]+$/u.test(remote.owner) ||
    !/^[A-Za-z0-9_.-]+$/u.test(remote.repo)
  ) {
    throw new Error("GitHub publication requires a GitHub remote.");
  }
  const pushRepository = `${remote.owner}/${remote.repo}`;
  const branch = source.branch;
  const raw = await requireGitHubPublicationCommand(
    [
      "gh",
      "api",
      "--hostname",
      githubHost,
      `repos/${pushRepository}`,
      "--jq",
      "{fork, default_branch, parent: {name: .parent.name, default_branch: .parent.default_branch, owner: {login: .parent.owner.login}}}",
    ],
    { env: params.identity.env, beforeRun: assertCurrent },
  );
  assertCurrent();
  const value: unknown = JSON.parse(raw);
  const target = resolveGitHubRepositoryTarget(value, remote);
  if (!target) {
    throw new Error("GitHub repository response omitted its publication target.");
  }
  const repository = `${target.pullRequest.owner}/${target.pullRequest.repo}`;
  const baseBranch = target.fork
    ? target.pullRequest.defaultBranch
    : parseGitHubPublicationBaseBranch(source.baseRef, target.pullRequest.defaultBranch);
  if (!target.fork && branch === baseBranch) {
    throw new RepositoryPublicationWorkspaceChangedError(
      "GitHub publication branch changed to its pull request base.",
    );
  }
  return {
    pushRepository,
    repository,
    branch,
    baseBranch,
    pushOwner: target.push.owner,
    githubHost,
  };
}

/** A refreshed observation must still name the bound PR and its original repositories/refs. */
function assertBoundGitHubPullRequest(
  binding: SessionGitHubPullRequestBinding,
  current: SessionGitHubPullRequestInspectResult,
): void {
  if (
    current.url !== binding.url ||
    current.host !== binding.host ||
    current.number !== binding.number ||
    !current.head ||
    current.base.repository !== binding.base.repository ||
    current.base.repositoryId !== binding.base.repositoryId ||
    current.base.branch !== binding.base.branch ||
    current.head.repository !== binding.head.repository ||
    current.head.repositoryId !== binding.head.repositoryId ||
    current.head.branch !== binding.head.branch
  ) {
    throw new RepositoryPublicationWorkspaceChangedError(
      "The original PR target changed; saved work was preserved.",
    );
  }
}

/** Revalidate the exact existing PR; local receipt ancestry remains host-owned. */
export async function prepareBoundGitHubPublication(
  params: Parameters<RepositoryPublicationProvider["prepareBoundPublication"]>[0],
) {
  const binding = params.pullRequest;
  let assertInspected: (() => void) | undefined;
  const assertCurrent = () => {
    params.assertCurrent();
    try {
      assertInspected?.();
    } catch {
      throw new RepositoryPublicationRequesterUnavailableError();
    }
  };
  const refresh = async () => {
    const inspected = await inspectOwnGitHubPullRequest({
      pullRequestUrl: binding.url,
      agentId: params.agentId,
      reader: params.reader,
      assertCurrent: params.assertCurrent,
    }).catch(() => {
      throw new RepositoryPublicationRequesterUnavailableError();
    });
    assertBoundGitHubPullRequest(binding, inspected.result);
    const observedHead = inspected.result.head!.commit;
    // A retried request may already have pushed its own journaled commit. The executor
    // verifies that commit's exact tree, parent and request marker before any new effect.
    const observedPublication =
      params.journaledHead !== params.sourceHead && observedHead === params.journaledHead;
    if (observedHead !== params.expectedHead && !observedPublication) {
      throw new GitHubPublicationBranchChangedError({ originalPullRequest: true });
    }
    assertInspected = inspected.assertCurrent;
    if (!observedPublication) {
      await assertExistingPullRequestWriteAccess({
        pullRequest: inspected.result,
        identity: await (async () => {
          await params.publisher.refresh();
          return readGitHubPublisher(params.publisher);
        })(),
        assertCurrent,
        requirePublicRepositories: inspected.requirePublicRepositories,
      });
    }
    assertCurrent();
    return observedPublication;
  };
  const observedPublication = await refresh();
  return { assertCurrent, refresh, observedPublication };
}
