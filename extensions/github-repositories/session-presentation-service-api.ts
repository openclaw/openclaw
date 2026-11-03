import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  NativeGitHubSessionPresentation as RepositorySessionPresentation,
  NativeGitHubSessionReads as RepositorySessionReads,
} from "openclaw/plugin-sdk/native-github-session-read";
import {
  loadControlUiSessionPullRequestChecks,
  clearSessionPullRequestCheckDetails,
} from "./control-ui-session-pr-check-details-api.js";
import { clearSessionPullRequestMetadata } from "./control-ui-session-pr-metadata-api.js";
import { repositorySessionPrTarget } from "./control-ui-session-pr-read-api.js";
import { createControlUiSessionPullRequestSubscriptions } from "./control-ui-session-pr-subscriptions-api.js";
import {
  clearSessionBranchPullRequests,
  gitHubCheckoutContext,
  readKnownSessionBranchMergedHeads,
} from "./control-ui-session-prs-api.js";

/** The enabled plugin owns its watches, cache, polling jobs and presentation registration. */
export function startGitHubSessionPresentation(params: {
  scheduler: Parameters<typeof createControlUiSessionPullRequestSubscriptions>[0]["scheduler"];
  getConfig: () => OpenClawConfig;
  reads: RepositorySessionReads;
}) {
  const reads = params.reads;
  const paramsConfig = params.getConfig;
  const clearCaches = () => {
    clearSessionBranchPullRequests();
    clearSessionPullRequestMetadata();
    clearSessionPullRequestCheckDetails();
  };
  const subscriptions = createControlUiSessionPullRequestSubscriptions({ ...params, reads });
  const presentation: RepositorySessionPresentation = {
    ...subscriptions,
    stop: () => stopPresentation(),
    checks: (read, query, assertCurrent) =>
      read.withSource(async (sourceScope) => {
        const target = repositorySessionPrTarget(read, paramsConfig(), read);
        let guard: (() => void) | undefined;
        let credential:
          | import("./control-ui-session-pr-request-api.js").SessionPullRequestReadCredential
          | undefined;
        const assertReadCurrent = () => {
          assertCurrent();
          read.assertCurrent();
          sourceScope.assertCurrent();
          guard?.();
        };
        const { loadControlUiSessionPullRequests } =
          await import("./control-ui-session-prs-api.js");
        return await loadControlUiSessionPullRequestChecks(
          { ...query, ...target.params },
          {
            sessionScope: target.identity,
            credential: () => credential,
            assertCurrent: assertReadCurrent,
            loadPullRequests: (request) =>
              loadControlUiSessionPullRequests(request, {
                read: {
                  target,
                  sourceIdentity: sourceScope.identity,
                  sourceScope,
                  assertCurrent: assertReadCurrent,
                  retainReadAuthority: (current, selected) => {
                    guard = current;
                    credential = selected;
                  },
                },
              }),
          },
        );
      }),
    readPrepared: (observation, admitLoad) =>
      subscriptions.readPrepared(
        repositorySessionPrTarget(observation, params.getConfig()),
        admitLoad,
      ),
    read: (read, assertCurrent, projection) =>
      subscriptions.read(
        repositorySessionPrTarget(read, params.getConfig(), read),
        assertCurrent,
        projection,
      ),
    knownMergedHeads: async (observation) =>
      reads.withSource(observation, async (sourceScope) => {
        const facts = await sourceScope.readCheckoutFacts();
        const context = gitHubCheckoutContext(
          facts ?? null,
          repositorySessionPrTarget(observation, params.getConfig()).githubHost,
        );
        if (!context || (observation.worktree && context.branch !== observation.worktree.branch)) {
          return [];
        }
        const target = repositorySessionPrTarget(observation, params.getConfig());
        return readKnownSessionBranchMergedHeads(context, {
          target,
          sourceScope,
          sourceIdentity: sourceScope.identity,
          assertCurrent: sourceScope.assertCurrent,
        });
      }),
  };
  let uninstall: (() => void) | undefined;
  let stopChanges: (() => void) | undefined;
  try {
    stopChanges = reads.subscribeChanges((change) => {
      if (change.kind === "reset") {
        clearCaches();
      }
    });
    uninstall = reads.installPresentation(presentation);
  } catch (error) {
    stopChanges?.();
    clearCaches();
    void subscriptions.stop();
    throw error;
  }
  let stop: Promise<void> | undefined;
  function stopPresentation() {
    uninstall?.();
    stopChanges?.();
    clearCaches();
    return (stop ??= subscriptions.stop());
  }
  return { reads, presentation, stop: stopPresentation };
}
