import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import {
  type NativeGitHubPublicationObjectPlan as RepositoryPublicationObjectPlan,
  nativeGitHubPublicationBaseBranch as parseGitHubPublicationBaseBranch,
  hasNativeGitHubPublicationMessageFooter as hasGitHubPublicationMessageFooter,
  NativeGitHubPublicationWorkspaceChangedError as RepositoryPublicationWorkspaceChangedError,
} from "openclaw/plugin-sdk/native-github-publication-host";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveGitHubHost } from "./host-runtime-api.js";
import { formatGitHubPublicationContent } from "./publication-content-api.js";
import {
  GitHubPublicationBranchChangedError,
  GitHubPublicationCreditChangedError,
  GitHubPublicationKnownFailure,
} from "./publication-failure-api.js";
import {
  runGitHubPublicationCommand,
  requireGitHubPublicationCommand,
  githubPublicationApiArgs,
} from "./publication-git-transport-api.js";
import { readGitHubPublisher } from "./publication-publisher-api.js";
import { findGitHubPublicationPullRequest } from "./publication-pull-requests-api.js";
import {
  hasRepositoryGitHubPublicationWorkflowChanges,
  prepareGitHubPublicationWorkflowGuard,
} from "./publication-workflows-api.js";
import { parseGitHubRemoteUrl } from "./remote-api.js";
import { resolveGitHubRepositoryTarget } from "./repository-target-api.js";
import type { PreparedGitHubPublicationIdentity } from "./tool-identity-api.js";

async function api(
  endpoint: string,
  identity: PreparedGitHubPublicationIdentity,
  assertCurrent: () => void,
  body?: unknown,
): Promise<unknown> {
  assertCurrent();
  const raw = await requireGitHubPublicationCommand(
    githubPublicationApiArgs(
      endpoint,
      body === undefined ? "GET" : "POST",
      identity.host ?? resolveGitHubHost(),
    ),
    {
      env: identity.env,
      beforeRun: assertCurrent,
      ...(body === undefined ? {} : { input: JSON.stringify(body) }),
    },
  );
  assertCurrent();
  return JSON.parse(raw);
}

function objectSha(value: unknown): string {
  if (!isRecord(value) || typeof value.sha !== "string" || !/^[a-f0-9]{40}$/u.test(value.sha)) {
    throw new Error("GitHub returned an invalid Git object identity.");
  }
  return value.sha;
}

export async function prepareRepositoryGitHubPublicationTarget(
  workspace: { url: string; branch: string; requestedRef?: string },
  identity: PreparedGitHubPublicationIdentity,
  assertCurrent: () => void,
) {
  const githubHost = identity.host ?? resolveGitHubHost();
  const remote = parseGitHubRemoteUrl(workspace.url, githubHost);
  if (
    !remote ||
    !/^[A-Za-z0-9_.-]+$/u.test(remote.owner) ||
    !/^[A-Za-z0-9_.-]+$/u.test(remote.repo)
  ) {
    throw new Error("GitHub publication requires a GitHub remote.");
  }
  const pushRepository = remote.owner + "/" + remote.repo;
  const value = await api("repos/" + pushRepository, identity, assertCurrent);
  const target = resolveGitHubRepositoryTarget(value, remote);
  if (!target) {
    throw new Error("GitHub repository response omitted its publication target.");
  }
  let baseBranch = target.fork
    ? target.pullRequest.defaultBranch
    : parseGitHubPublicationBaseBranch(
        workspace.requestedRef ?? "HEAD",
        target.pullRequest.defaultBranch,
      );
  if (!target.fork && baseBranch !== target.pullRequest.defaultBranch) {
    const refs = await api(
      "repos/" + pushRepository + "/git/matching-refs/heads/" + encodeURIComponent(baseBranch),
      identity,
      assertCurrent,
    );
    if (!Array.isArray(refs)) {
      throw new Error("GitHub publication base branch lookup was invalid.");
    }
    if (!refs.some((ref) => isRecord(ref) && ref.ref === "refs/heads/" + baseBranch)) {
      // Tags and detached commits select source contents, not a pull-request base branch.
      baseBranch = target.pullRequest.defaultBranch;
    }
  }
  if (workspace.branch === baseBranch) {
    throw new RepositoryPublicationWorkspaceChangedError(
      "GitHub publication branch is its pull request base.",
    );
  }
  return {
    pushRepository,
    repository: target.pullRequest.owner + "/" + target.pullRequest.repo,
    baseBranch,
  };
}

/** GitHub receives only accepted normalized objects; the Gateway never fetches source history. */
export async function executeRepositoryGitHubPublication(params: RepositoryPublicationObjectPlan) {
  const { snapshot } = params;
  const assertCurrent = () => {
    params.assertCurrent();
    params.publisher.assertCurrent();
  };
  const refreshIdentity = async () => {
    assertCurrent();
    await params.publisher.refresh();
    assertCurrent();
    return readGitHubPublisher(params.publisher);
  };
  {
    assertCurrent();
    const { pushRepository, repository, baseBranch, branch } = params.target;
    if (
      !pushRepository ||
      !repository ||
      !baseBranch ||
      !snapshot.baseCommit ||
      !snapshot.baseTree ||
      !snapshot.workspaceTree
    ) {
      throw new RepositoryPublicationWorkspaceChangedError(
        "GitHub publication accepted checkpoint changed.",
      );
    }
    let identity = await refreshIdentity();
    const endpoint = "repos/" + pushRepository + "/git/";
    const sourceRepository = await api("repos/" + pushRepository, identity, assertCurrent);
    if (
      !isRecord(sourceRepository) ||
      typeof sourceRepository.node_id !== "string" ||
      !sourceRepository.node_id
    ) {
      throw new Error("GitHub publication repository identity is unavailable.");
    }
    const base = await api(endpoint + "commits/" + snapshot.baseCommit, identity, assertCurrent);
    if (
      !isRecord(base) ||
      objectSha(base.tree) !== snapshot.baseTree ||
      objectSha(base) !== snapshot.baseCommit
    ) {
      throw new RepositoryPublicationWorkspaceChangedError(
        "GitHub publication pinned repository base changed.",
      );
    }
    const baseRef = await api(
      "repos/" + repository + "/git/ref/heads/" + encodeURIComponent(baseBranch),
      identity,
      assertCurrent,
    );
    if (!isRecord(baseRef) || baseRef.ref !== "refs/heads/" + baseBranch) {
      throw new Error("GitHub publication workspace base branch could not be verified.");
    }
    const remoteBase = objectSha(baseRef.object);
    const readMergeBase = async (source: string) => {
      const lineage = await requireGitHubPublicationCommand(
        [
          ...githubPublicationApiArgs(
            "repos/" + repository + "/compare/" + source + "..." + remoteBase + "?per_page=1",
            "GET",
            identity.host ?? resolveGitHubHost(),
          ),
          "--jq",
          "{sha: .merge_base_commit.sha}",
        ],
        { env: identity.env, beforeRun: assertCurrent },
      );
      assertCurrent();
      return objectSha(JSON.parse(lineage));
    };
    // A requested topic/tag/commit may be ahead of or diverged from the PR base.
    // GitHub's merge-base proves shared history without changing the accepted source.
    const mergeBase = await readMergeBase(snapshot.baseCommit);
    let headCommit = params.headCommit;
    let preparedCommitMessage: string | undefined;
    const verifyCommit = (value: unknown) => {
      if (
        !isRecord(value) ||
        objectSha(value.tree) !== snapshot.workspaceTree ||
        !Array.isArray(value.parents) ||
        value.parents.length !== 1 ||
        objectSha(value.parents[0]) !== (params.previousHeadCommit ?? snapshot.baseCommit) ||
        typeof value.message !== "string" ||
        !value.message.split(/\r?\n/u).includes("OpenClaw-Publication: " + params.request.requestId)
      ) {
        throw new RepositoryPublicationWorkspaceChangedError(
          "GitHub publication commit does not match its accepted checkpoint.",
        );
      }
      preparedCommitMessage = value.message;
      return objectSha(value);
    };
    if (headCommit) {
      const current = await api(endpoint + "commits/" + headCommit, identity, assertCurrent);
      if (verifyCommit(current) !== headCommit) {
        throw new Error("GitHub publication commit identity changed.");
      }
    }
    const observeHead = async () => {
      const observedIdentity = await refreshIdentity();
      const raw = await requireGitHubPublicationCommand(
        githubPublicationApiArgs(
          endpoint + "matching-refs/heads/" + encodeURIComponent(branch),
          "GET",
          observedIdentity.host ?? resolveGitHubHost(),
        ),
        { env: observedIdentity.env, beforeRun: assertCurrent },
      );
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value)) {
        throw new Error("GitHub branch observation was invalid.");
      }
      const ref = value.find((entry) => isRecord(entry) && entry.ref === "refs/heads/" + branch);
      const observed = isRecord(ref) ? objectSha(ref.object) : null;
      // Preserve an authenticated response to a lost push before checking whether
      // its admission closed during the read. This records no permission to act.
      if (headCommit && observed === headCommit) {
        await params.effects.record("push", { headCommit });
      }
      assertCurrent();
      return observed;
    };
    let remoteHead = await observeHead();
    if (remoteHead !== params.previousHeadCommit && (!headCommit || remoteHead !== headCommit)) {
      throw new GitHubPublicationBranchChangedError();
    }
    // Initial PR changes use GitHub's merge-base. Later checkpoints compare with
    // the preceding pushed tree, so restoring the PR base remains a real revert.
    const comparisonCommit = params.previousHeadCommit ?? mergeBase;
    const comparisonRepository = params.previousHeadCommit ? pushRepository : repository;
    const comparison =
      comparisonRepository === pushRepository && comparisonCommit === snapshot.baseCommit
        ? base
        : await api(
            "repos/" + comparisonRepository + "/git/commits/" + comparisonCommit,
            identity,
            assertCurrent,
          );
    if (!isRecord(comparison) || objectSha(comparison) !== comparisonCommit) {
      throw new Error("GitHub publication comparison commit changed.");
    }
    if (snapshot.workspaceTree === objectSha(comparison.tree)) {
      throw new GitHubPublicationKnownFailure("GitHub publication has no changes to publish.", {
        code: "no_changes",
        nextAction: "Make or restore a repository change, then retry.",
      });
    }
    const pushOwner = pushRepository.split("/")[0]!;
    const marker = "<!-- openclaw-publication:" + params.request.requestId + " -->";
    const findPullRequest = () =>
      findGitHubPublicationPullRequest({
        repository,
        pushOwner,
        branch,
        baseBranch,
        headCommit: headCommit ?? snapshot.baseCommit,
        marker,
        host: identity.host ?? resolveGitHubHost(),
        refreshIdentity,
        assertCurrent,
        recordObserved: (url) => params.effects.record("pull_request", { url }),
      });
    await findPullRequest();
    const assertWorkflowAuthority = await prepareGitHubPublicationWorkflowGuard(
      params.assertWorkflowChangesAllowed,
      () =>
        hasRepositoryGitHubPublicationWorkflowChanges({
          snapshot,
          sourceRepository: pushRepository,
          comparisonRepository,
          comparisonTree: objectSha(comparison.tree),
          readUpstream: async () => {
            // REST exposes one merge-base, not all of them. A source base on the
            // target's history (or containing it), followed only by our linear
            // checkpoint commits, has a unique best common ancestor. A diverged
            // source base cannot provide that proof without fetching its graph.
            if (mergeBase !== snapshot.baseCommit && mergeBase !== remoteBase) {
              return undefined;
            }
            const ancestor = params.previousHeadCommit
              ? await readMergeBase(params.previousHeadCommit)
              : mergeBase;
            const readTreeSha = async (commit: string) => {
              const value = await api(
                "repos/" + repository + "/git/commits/" + commit,
                identity,
                assertCurrent,
              );
              if (!isRecord(value) || objectSha(value) !== commit) {
                throw new Error("GitHub publication workflow commit changed.");
              }
              return objectSha(value.tree);
            };
            const [ancestorTree, targetTree] = await Promise.all([
              readTreeSha(ancestor),
              readTreeSha(remoteBase),
            ]);
            return { repository, ancestorTree, targetTree };
          },
          readTree: (owner, sha) =>
            api("repos/" + owner + "/git/trees/" + sha, identity, assertCurrent),
        }),
    );
    const assertPublicationAction = () => {
      assertWorkflowAuthority();
      assertCurrent();
    };
    assertPublicationAction();
    const content = formatGitHubPublicationContent({
      requestId: params.request.requestId,
      title: params.request.title,
      branch,
      description:
        params.request.body?.trim() ||
        "Published by the Gateway from the accepted repository checkpoint.",
      facts: await params.contentHost.prepare(),
    });
    const assertAction = () => {
      assertPublicationAction();
      content.assertCurrent();
    };
    assertAction();
    if (
      headCommit &&
      remoteHead !== headCommit &&
      !hasGitHubPublicationMessageFooter(
        preparedCommitMessage ?? "",
        content.trailers,
        "OpenClaw-Publication: " + params.request.requestId,
      )
    ) {
      throw new GitHubPublicationCreditChangedError();
    }
    if (!headCommit) {
      const shas = [
        ...new Set(
          snapshot.entries.flatMap((entry) =>
            entry.sha !== null && entry.mode !== "160000" ? [entry.sha] : [],
          ),
        ),
      ];
      identity = await refreshIdentity();
      const uploaded = await runTasksWithConcurrency({
        limit: 4,
        errorMode: "stop",
        tasks: shas.map((sha) => async () => {
          assertCurrent();
          const bytes = await params.snapshot.readBlob(sha);
          assertCurrent();
          const blob = await api(endpoint + "blobs", identity, assertAction, {
            content: bytes.toString("base64"),
            encoding: "base64",
          });
          if (objectSha(blob) !== sha) {
            throw new Error("GitHub publication blob content changed.");
          }
        }),
      });
      if (uploaded.hasError) {
        throw uploaded.firstError;
      }
      const tree =
        snapshot.entries.length === 0
          ? snapshot.baseTree
          : objectSha(
              await api(endpoint + "trees", identity, assertAction, {
                base_tree: snapshot.baseTree,
                tree: snapshot.entries.map((entry) => ({
                  path: entry.path,
                  mode: entry.mode,
                  type: entry.mode === "160000" ? "commit" : "blob",
                  sha: entry.sha,
                })),
              }),
            );
      if (tree !== snapshot.workspaceTree) {
        throw new RepositoryPublicationWorkspaceChangedError(
          "GitHub publication normalized tree changed.",
        );
      }
      const author = {
        name: identity.account.login,
        email:
          identity.account.accountId + "+" + identity.account.login + "@users.noreply.github.com",
        date: new Date(params.request.createdAtMs).toISOString(),
      };
      const commit = await api(endpoint + "commits", identity, assertAction, {
        tree: snapshot.workspaceTree,
        parents: [params.previousHeadCommit ?? snapshot.baseCommit],
        author,
        committer: author,
        message: content.commitMessage,
      });
      headCommit = verifyCommit(commit);
      await params.prepareCommit(headCommit);
    }
    if (remoteHead !== headCommit) {
      identity = await refreshIdentity();
      assertAction();
      await params.effects.record("push");
      // GraphQL's beforeOid is an exact lease; REST's non-force update only checks ancestry.
      const result = await runGitHubPublicationCommand(
        githubPublicationApiArgs("graphql", "POST", identity.host ?? resolveGitHubHost()),
        {
          env: identity.env,
          beforeRun: assertAction,
          input: JSON.stringify({
            query:
              "mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
            variables: {
              input: {
                repositoryId: sourceRepository.node_id,
                clientMutationId: params.request.requestId,
                refUpdates: [
                  {
                    name: "refs/heads/" + branch,
                    beforeOid: remoteHead ?? "0".repeat(40),
                    afterOid: headCommit,
                    force: false,
                  },
                ],
              },
            },
          }),
        },
      );
      let succeeded = false;
      if (result.code === 0) {
        const reply: unknown = JSON.parse(result.stdout.toString("utf8"));
        succeeded =
          isRecord(reply) &&
          !reply.errors &&
          isRecord(reply.data) &&
          isRecord(reply.data.updateRefs) &&
          reply.data.updateRefs.clientMutationId === params.request.requestId;
      }
      await params.effects.record("push", succeeded ? { headCommit } : {});
      assertCurrent();
      remoteHead = await observeHead();
      if (remoteHead !== headCommit) {
        throw new Error("GitHub push verification failed.");
      }
    }
    let url = await findPullRequest();
    if (!url) {
      identity = await refreshIdentity();
      assertAction();
      await params.effects.record("pull_request");
      const created = await runGitHubPublicationCommand(
        githubPublicationApiArgs(
          `repos/${repository}/pulls`,
          "POST",
          identity.host ?? resolveGitHubHost(),
        ),
        {
          env: identity.env,
          beforeRun: assertAction,
          input: () =>
            JSON.stringify({
              title: content.title,
              body: content.pullRequestBody(),
              head: pushOwner + ":" + branch,
              base: baseBranch,
              // Requests accepted before the choice was introduced created drafts.
              draft: params.request.draft,
            }),
        },
      );
      if (created.code === 0) {
        const value: unknown = JSON.parse(created.stdout.toString("utf8"));
        if (isRecord(value) && typeof value.html_url === "string") {
          url = value.html_url;
        }
      }
      await params.effects.record("pull_request", url ? { url } : {});
      if (!url) {
        assertCurrent();
        url = await findPullRequest();
      }
    }
    if (!url) {
      throw new Error("GitHub pull request creation was rejected.");
    }
    return { url, headCommit };
  }
}
