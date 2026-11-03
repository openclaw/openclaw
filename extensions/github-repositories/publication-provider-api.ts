import { getActiveSecretsRuntimeConfigSnapshot } from "openclaw/plugin-sdk/channel-secret-owner-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { NativeGitHubPublicationFailureError as RepositoryPublicationFailureError } from "openclaw/plugin-sdk/native-github-publication-host";
import type { NativeGitHubPublicationProvider as RepositoryPublicationProvider } from "openclaw/plugin-sdk/native-github-publication-host";
import { isRecord, readNonBlankString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { githubRepositoryUrl, resolveConfiguredGitHubHost } from "./host-api.js";
import { resolveGitHubHost } from "./host-runtime-api.js";
import {
  bindPersonalGitHubPublicationSelection,
  preparePersonalGitHubPublicationSelection,
} from "./personal-publication-api.js";
import {
  personalGitHubStatusAsync,
  resolvePersonalGitHubStatus,
  revalidatePersonalGitHubStatus,
} from "./personal-status-api.js";
import { performGitHubPullRequestAction } from "./publication-actions-api.js";
import {
  prepareCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationOptionsIdentity,
} from "./publication-availability-api.js";
import { formatGitHubPublicationContent } from "./publication-content-api.js";
import {
  resolveGitHubPublicationFailure,
  isDefinitiveGitHubPublicationFailure,
  GitHubPublicationObservationUnavailableError,
} from "./publication-failure-api.js";
import {
  runGitHubPublicationCommand,
  requireGitHubPublicationCommand,
  createGitHubPublicationApiRunner,
  githubPublicationApiArgs,
  readGitHubPublicationBaseSha,
} from "./publication-git-transport-api.js";
import { inspectOwnGitHubPullRequest } from "./publication-inspect-api.js";
import { assertExistingPullRequestWriteAccess } from "./publication-pr-preflight-api.js";
import { prepareGitHubPublisher, readGitHubPublisher } from "./publication-publisher-api.js";
import {
  readPublishedGitHubPullRequest,
  findGitHubPublicationPullRequest,
  reconcileGitHubPublicationPullRequest,
} from "./publication-pull-requests-api.js";
import { isGitHubPublicationSuperseded } from "./publication-relevance-api.js";
import {
  prepareBoundGitHubPublication,
  prepareGitHubPublicationTarget,
} from "./publication-target-api.js";
import { formatGitHubPublicationTranscript } from "./publication-transcript-api.js";
import {
  prepareGitHubPublicationWorkflowGuard,
  hasUnapprovedGitHubPublicationWorkflowChanges,
  isGitHubPublicationWorkflowPath,
} from "./publication-workflows-api.js";
import { GitHubIdentityError } from "./read-identity-api.js";
import { parseGitHubRemoteUrl } from "./remote-api.js";
import {
  executeRepositoryGitHubPublication,
  prepareRepositoryGitHubPublicationTarget,
} from "./repository-publication-executor-api.js";
import {
  resolveConfiguredGitHubToolIdentity,
  prepareGitHubPublicationIdentity,
  matchesPreparedGitHubPublicationIdentity,
} from "./tool-identity-api.js";
import {
  prepareGitHubWorkerIdentity,
  subscribeGitHubWorkerIdentityChanges,
} from "./worker-identity-api.js";

function workflowTree(raw: Buffer | undefined) {
  if (!raw) {
    return undefined;
  }
  const entries = new Map<string, string>();
  for (const entry of raw.toString("latin1").split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, , sha] = entry.slice(0, tab).split(" ");
    if (tab < 0 || !mode || !sha) {
      throw new Error("Publication tree could not be verified.");
    }
    const path = entry.slice(tab + 1);
    if (isGitHubPublicationWorkflowPath(path)) {
      entries.set(path, mode + ":" + sha);
    }
  }
  return entries;
}
export function createGitHubPublicationProvider(owner: {
  signal: AbortSignal;
  assertCurrent: () => void;
  getConfig: () => OpenClawConfig;
  refreshIdentity: (agentId: string) => Promise<void>;
  refreshPersonal: (profileId: string) => Promise<void>;
}): RepositoryPublicationProvider {
  const assertCurrent = owner.assertCurrent;

  return {
    supportsOrigin(originUrl) {
      assertCurrent();
      const remote = parseGitHubRemoteUrl(
        originUrl,
        resolveConfiguredGitHubHost(owner.getConfig()),
      );
      return Boolean(
        remote && /^[A-Za-z0-9_.-]+$/u.test(remote.owner) && /^[A-Za-z0-9_.-]+$/u.test(remote.repo),
      );
    },
    id: "github-repositories",
    assertCurrent,
    formatReport: formatGitHubPublicationTranscript,
    resolveGitAuthor(agentId) {
      assertCurrent();
      const config = owner.getConfig();
      return (
        resolveConfiguredGitHubToolIdentity({ config, agentId, scope: "agent" }) ??
        resolveConfiguredGitHubToolIdentity({ config, agentId, scope: "system" })
      )?.gitAuthor;
    },
    prepareWorkerIdentity: (input) => prepareGitHubWorkerIdentity(owner, input),
    subscribeWorkerIdentityChanges: subscribeGitHubWorkerIdentityChanges,
    preparePublisher: (agentId, expected) =>
      prepareGitHubPublisher(agentId, expected, {
        prepare: async () => {
          assertCurrent();
          await owner.refreshIdentity(agentId);
          assertCurrent();
          const config = owner.getConfig();
          return prepareGitHubPublicationIdentity({
            config,
            sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
            agentId,
            assertCurrent,
          });
        },
        isCurrent: (identity) => {
          assertCurrent();
          return matchesPreparedGitHubPublicationIdentity({
            config: owner.getConfig(),
            agentId,
            identity,
          });
        },
      }),
    async bindPersonal(input) {
      const bound = await bindPersonalGitHubPublicationSelection(
        input.action,
        input.selected,
        input.preparation,
      );
      const selected = {
        source: "personal" as const,
        profileId: bound.profileId,
        account: input.selected.account,
      };
      const provenance = selected;
      return {
        provenance,
        generation: input.selected.generation,
        assertCurrent: () => {
          input.action.assertCurrent();
          bound.assertCurrent();
        },
        // Capture the verified account in the receipt before claim rebinds its stored selection.
        prepare: async (assertWorkspace) =>
          prepareGitHubPublisher(input.action.agentId, undefined, {
            prepare: () =>
              preparePersonalGitHubPublicationSelection(
                bound,
                assertWorkspace,
                owner.refreshPersonal,
              ),
            isCurrent: () => {
              input.action.assertCurrent();
              assertWorkspace();
              bound.assertCurrent();
              return true;
            },
          }),
      };
    },
    async readOptionsIdentity(input) {
      const current = () => {
        assertCurrent();
        input.assertCurrent();
      };
      current();
      try {
        const identity = await prepareCurrentGitHubPublicationOptionsIdentity(
          input.agentId,
          current,
        );
        current();
        return { identity };
      } catch (error) {
        current();
        return {
          identity: null,
          unavailableReason: error instanceof GitHubIdentityError ? error.reason : "unverified",
        };
      }
    },
    async preparePersonalAccountStatus(action) {
      assertCurrent();
      const status = await resolvePersonalGitHubStatus(action);
      assertCurrent();
      return {
        status,
        assertCurrent() {
          assertCurrent();
          revalidatePersonalGitHubStatus(action, status);
        },
      };
    },
    async isPublicationSuperseded(snapshot, readPublished) {
      assertCurrent();
      const result = await isGitHubPublicationSuperseded(snapshot, readPublished);
      assertCurrent();
      return result;
    },
    async readPersonalSelection(action) {
      const status = await personalGitHubStatusAsync(action);
      action.assertCurrent();
      return {
        generation: status.generation,
        provenance: status.account ? { source: "personal", account: status.account } : null,
      };
    },
    async performPullRequestAction(input) {
      assertCurrent();
      input.assertCurrent();
      const result = await performGitHubPullRequestAction({
        ...input,
        assertCurrent() {
          assertCurrent();
          input.assertCurrent();
        },
      });
      assertCurrent();
      input.assertCurrent();
      return result;
    },
    async inspectPullRequest(input) {
      const inspected = await inspectOwnGitHubPullRequest(input);
      const assertInspection = () => {
        input.assertCurrent();
        inspected.assertCurrent();
      };
      const verifyWriteAccess = async () => {
        const identity = await prepareCurrentGitHubPublicationIdentity(
          input.agentId,
          assertInspection,
        );
        assertInspection();
        await assertExistingPullRequestWriteAccess({
          pullRequest: inspected.result,
          identity,
          assertCurrent: assertInspection,
          requirePublicRepositories: inspected.requirePublicRepositories,
        });
      };
      return {
        result: inspected.result,
        ownPublication: inspected.ownPublication,
        publishedHeadCommit: inspected.publishedHeadCommit,
        assertCurrent: assertInspection,
        verifyWriteAccess,
        assertSource(originUrl) {
          assertInspection();
          const remote = parseGitHubRemoteUrl(originUrl, inspected.result.host);
          const name = remote && `${remote.owner}/${remote.repo}`.toLowerCase();
          if (
            !name ||
            ![inspected.result.base.repository, inspected.result.head?.repository].some(
              (candidate) => candidate?.toLowerCase() === name,
            )
          ) {
            throw new Error(
              "This workspace belongs to another repository. Its existing files and history were preserved.",
            );
          }
        },
      };
    },
    prepareBoundPublication: prepareBoundGitHubPublication,
    async prepareTarget(input) {
      assertCurrent();
      input.assertCurrent();
      input.publisher.assertCurrent();
      const identity = readGitHubPublisher(input.publisher);
      if (input.recorded) {
        const original = parseGitHubRemoteUrl(
          input.originUrl,
          identity.host ?? resolveGitHubHost(),
        );
        if (
          !original ||
          `${original.owner}/${original.repo}`.toLowerCase() !==
            input.recorded.pushRepository.toLowerCase()
        ) {
          throw new Error("GitHub publication's original target is unavailable.");
        }
      }
      const target = input.recorded
        ? {
            ...input.recorded,
            branch: input.branch,
            githubHost: identity.host ?? resolveGitHubHost(),
          }
        : input.repositoryOnly
          ? {
              ...(await prepareRepositoryGitHubPublicationTarget(
                { url: input.originUrl, branch: input.branch, requestedRef: input.baseRef },
                identity,
                input.assertCurrent,
              )),
              branch: input.branch,
              githubHost: identity.host ?? resolveGitHubHost(),
            }
          : await prepareGitHubPublicationTarget({
              source: input,
              identity,
              assertCurrent: input.assertCurrent,
            });
      return {
        ...target,
        ...(input.pullRequest ? { pullRequest: input.pullRequest } : {}),
        remoteUrl: githubRepositoryUrl(target.pushRepository, target.githubHost),
        baseRemoteUrl: githubRepositoryUrl(target.repository, target.githubHost),
      };
    },
    async preparePublishedTarget(input) {
      assertCurrent();
      input.assertCurrent();
      const identity = readGitHubPublisher(input.publisher);
      const { candidate } = await readPublishedGitHubPullRequest({
        publishedPullRequest: input.publishedPullRequest,
        repository: input.target.repository,
        branch: input.target.branch,
        host: identity.host ?? resolveGitHubHost(),
        publisherAccountId: input.publisherAccountId,
        refreshIdentity: async () => identity,
        assertCurrent: input.assertCurrent,
      });
      input.assertCurrent();
      if (!input.reconcile && candidate.state === "closed") {
        return input.target;
      }
      return {
        ...input.target,
        baseBranch: candidate.baseRef,
        publishedPullRequest: input.publishedPullRequest,
      };
    },
    async readBase(input) {
      const identity = readGitHubPublisher(input.publisher);
      return await readGitHubPublicationBaseSha(
        createGitHubPublicationApiRunner(input.assertCurrent).run,
        input.target.repository,
        input.target.baseBranch,
        identity.host ?? resolveGitHubHost(),
        identity.env,
      );
    },
    async observeBranch(input) {
      input.assertCurrent();
      const identity = readGitHubPublisher(input.publisher);
      try {
        const raw = await requireGitHubPublicationCommand(
          githubPublicationApiArgs(
            `repos/${input.target.pushRepository}/git/matching-refs/heads/${encodeURIComponent(input.target.branch)}`,
            "GET",
            identity.host ?? resolveGitHubHost(),
          ),
          { env: identity.env, beforeRun: input.assertCurrent },
        );
        input.assertCurrent();
        const value: unknown = JSON.parse(raw);
        if (!Array.isArray(value)) {
          throw new GitHubPublicationObservationUnavailableError();
        }
        const ref = value.find(
          (entry) => isRecord(entry) && entry.ref === `refs/heads/${input.target.branch}`,
        );
        if (ref === undefined) {
          return null;
        }
        if (
          !isRecord(ref) ||
          !isRecord(ref.object) ||
          typeof ref.object.sha !== "string" ||
          !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(ref.object.sha)
        ) {
          throw new GitHubPublicationObservationUnavailableError();
        }
        return ref.object.sha;
      } catch {
        // Lost authority remains an authority failure; read unavailability never
        // proves an absent branch or a rejected earlier write.
        input.assertCurrent();
        throw new GitHubPublicationObservationUnavailableError();
      }
    },
    async findPullRequest(input) {
      return await findGitHubPublicationPullRequest({
        repository: input.target.repository,
        pullRequest: input.target.pullRequest,
        publishedPullRequest: input.target.publishedPullRequest,
        pushOwner: input.target.pushRepository.split("/")[0]!,
        branch: input.target.branch,
        baseBranch: input.target.baseBranch,
        marker: `<!-- openclaw-publication:${input.request.requestId} -->`,
        headCommit: input.headCommit,
        host: readGitHubPublisher(input.publisher).host,
        assertCurrent: input.assertCurrent,
        recordObserved: input.recordObserved,
        refreshIdentity: async () => {
          await input.publisher.refresh();
          return readGitHubPublisher(input.publisher);
        },
      });
    },
    async createPullRequest(input) {
      const identity = readGitHubPublisher(input.publisher);
      const result = await runGitHubPublicationCommand(
        githubPublicationApiArgs(
          `repos/${input.target.repository}/pulls`,
          "POST",
          identity.host ?? resolveGitHubHost(),
        ),
        {
          env: identity.env,
          beforeRun: input.assertCurrent,
          input: () =>
            JSON.stringify({
              title: input.content.title,
              body: input.content.pullRequestBody(),
              head: `${input.target.pushRepository.split("/")[0]!}:${input.target.branch}`,
              base: input.target.baseBranch,
              draft: input.request.draft,
            }),
        },
      );
      if (result.code !== 0) {
        return undefined;
      }
      const value: unknown = JSON.parse(result.stdout.toString("utf8"));
      return isRecord(value) ? readNonBlankString(value.html_url) : undefined;
    },
    async reconcile(input) {
      return await reconcileGitHubPublicationPullRequest({
        requestId: input.request.requestId,
        pushRepository: input.target.pushRepository,
        repository: input.target.repository,
        pullRequest: input.target.pullRequest,
        publishedPullRequest: input.target.publishedPullRequest,
        pushOwner: input.target.pushRepository.split("/")[0]!,
        branch: input.target.branch,
        baseBranch: input.target.baseBranch,
        marker: `<!-- openclaw-publication:${input.request.requestId} -->`,
        headCommit: input.headCommit,
        workspaceTree: input.workspaceTree,
        parentCommit: input.parentCommit,
        knownPullRequestUrls: input.knownPullRequestUrls,
        pushOnly: input.pushOnly,
        beforeRetry: input.beforeRetry,
        readContinuation: input.readContinuation,
        recordObserved: input.recordObserved,
        recordPushObserved: input.recordPushObserved,
        assertCurrent: input.assertCurrent,
        refreshIdentity: async () => {
          await input.publisher.refresh();
          return readGitHubPublisher(input.publisher);
        },
      });
    },
    async formatContent(input) {
      readGitHubPublisher(input.publisher);
      const facts = await input.host.prepare();
      return formatGitHubPublicationContent({
        requestId: input.request.requestId,
        title: input.request.title,
        branch: input.target.branch,
        description: input.description,
        facts,
      });
    },
    async prepareChangeGuard(input) {
      return await prepareGitHubPublicationWorkflowGuard(input.assertPermission, async () => {
        const [before, accepted] = await Promise.all([
          input.readTree("before"),
          input.readTree("accepted"),
        ]);
        const beforeTree = workflowTree(before);
        const acceptedTree = workflowTree(accepted);
        if (!beforeTree || !acceptedTree) {
          throw new Error("Publication workflow trees could not be verified.");
        }
        return hasUnapprovedGitHubPublicationWorkflowChanges({
          before: beforeTree,
          accepted: acceptedTree,
          readUpstream: async () => {
            const ancestor = workflowTree(await input.readTree("ancestor"));
            if (!ancestor) {
              return undefined;
            }
            const target = workflowTree(await input.readTree("target"));
            return target ? { ancestor, target } : undefined;
          },
        });
      });
    },
    executeRepository: executeRepositoryGitHubPublication,
    resolveFailure(error) {
      return resolveGitHubPublicationFailure(error);
    },
    isDefinitiveFailure(error) {
      return (
        error instanceof RepositoryPublicationFailureError ||
        isDefinitiveGitHubPublicationFailure(error)
      );
    },
  };
}
