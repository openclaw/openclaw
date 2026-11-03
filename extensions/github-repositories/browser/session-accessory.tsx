/** @jsxImportSource @solidjs/web */

import type { ControlUiSessionPullRequestSnapshot } from "@openclaw/gateway-protocol";
import type {
  ControlUiSessionAccessory,
  ControlUiHostV2,
  ControlUiSessionOperationFactory,
} from "openclaw/plugin-sdk/control-ui";
import { createMemo, createSignal, Show } from "solid-js";
import {
  ChatPullRequests,
  hasChatPullRequests,
  type ChatPullRequestsProps,
} from "./chat-pull-requests.tsx";
import { RepositoryCiContext } from "./ci-context.ts";
import type { GitHubPublicationPresentationBinding } from "./github-publication-owner.ts";
import { MobileSessionContent } from "./mobile-session-content.tsx";
import { NativeContext } from "./native-context.tsx";
import { PresentationContext } from "./presentation-context.ts";
import { publicationEnglish } from "./publication-english.ts";
import {
  createPublicationPresentation,
  createPublicationFactory,
} from "./publication-presentation.ts";
import {
  chatPullRequestId,
  chatBranchId,
  browserDismissalStorage,
  listDismissedChatPullRequests,
  dismissChatPullRequest,
  repositoryEnvironmentWork,
} from "./pull-request-dismissal.ts";
import { pullRequestEnglish } from "./pull-request-english.ts";
import { mountPluginContent } from "./render-owned.ts";
import { RepositoryEnvironment } from "./repository-environment.tsx";
import type { RepositoryBrowserRuntime } from "./repository-runtime.ts";
import { orderSessionPullRequests } from "./session-pull-request-presentation.ts";
export function createSessionAccessoryMount(
  host: Pick<ControlUiHostV2, "native" | "presentation" | "sessions">,
  runtime: RepositoryBrowserRuntime,
  environment = false,
): ControlUiSessionAccessory["mount"] {
  const factory = createPublicationFactory(host);
  return (container, initial) =>
    mountSessionAccessory(container, initial, factory, runtime, undefined, environment);
}
export function createMobileSessionAccessoryMount(
  host: Pick<ControlUiHostV2, "native" | "presentation" | "sessions">,
  runtime: RepositoryBrowserRuntime,
  placement: "root" | "page" | "activity",
): ControlUiSessionAccessory["mount"] {
  const factory = createPublicationFactory(host);
  return (container, initial) =>
    mountSessionAccessory(container, initial, factory, runtime, placement);
}
function mountSessionAccessory(
  container: HTMLElement,
  initial: Parameters<ControlUiSessionAccessory["mount"]>[1],
  factory: ControlUiSessionOperationFactory<GitHubPublicationPresentationBinding>,
  runtime: RepositoryBrowserRuntime,
  mobile?: "root" | "page" | "activity",
  environment = false,
) {
  let context = initial;
  const native = initial.host.native;
  const presentation = initial.host.presentation;
  if (!native || !presentation) {
    throw new Error("Repository presentation services are unavailable.");
  }
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  function changed() {
    if (context.signal.aborted) {
      return;
    }
    setRevision((value) => value + 1);
    const value = readPresentation(runtime.store.get(key));
    context.props.onPresenceChange?.(
      environment ? Boolean(repositoryEnvironmentWork(value)) : hasChatPullRequests(value),
    );
  }
  const locale = {
    ...presentation,
    translate: (key: string, params?: Record<string, string>) => {
      revision();
      return presentation.translate(key, params);
    },
  };
  presentation.registerEnglish(publicationEnglish);
  presentation.registerEnglish(pullRequestEnglish);
  const publication = createPublicationPresentation(initial.host, () => context, changed, factory);
  const owner = {};
  let key = "";
  const sync = () => {
    if (context.signal.aborted) {
      return;
    }
    key = initial.host.sessions.artifactKey(context.props);
    runtime.store.watch(owner, key ? [key] : [], {
      foreground: context.presented,
      passive: !context.presented,
    });
    publication.sync();
    changed();
  };
  const viewContext = () => {
    revision();
    return context;
  };
  function readPresentation(
    snapshot: ControlUiSessionPullRequestSnapshot | undefined,
  ): ChatPullRequestsProps {
    const dismissed = listDismissedChatPullRequests(
      browserDismissalStorage(),
      context.props.sessionKey,
    );
    return {
      pullRequests: orderSessionPullRequests(
        (snapshot?.pullRequests ?? []).filter((pr) => !dismissed.has(chatPullRequestId(pr))),
      ),
      branch: snapshot?.branch,
      branchDismissed: Boolean(snapshot?.branch) && dismissed.has(chatBranchId(snapshot!.branch!)),
      status: snapshot?.status ?? "unavailable",
      publication: publication.view(),
      onDismiss: dismissPullRequest,
      publishedOnly: !mobile && !environment,
    };
  }
  const currentPresentation = () => {
    const facts = context.props.facts;
    return (
      !context.signal.aborted &&
      context.presented &&
      (!facts?.readCurrent || facts.readCurrent() !== undefined)
    );
  };
  function dismissPullRequest(pr: Parameters<typeof chatPullRequestId>[0]) {
    const id = chatPullRequestId(pr);
    if (!currentPresentation()) {
      return false;
    }
    if (
      !runtime.store.get(key)?.pullRequests.some((request) => chatPullRequestId(request) === id)
    ) {
      return false;
    }
    context.signal.throwIfAborted();
    dismissChatPullRequest(browserDismissalStorage(), context.props.sessionKey, id);
    changed();
    return true;
  }
  const stop = mountPluginContent(() => {
    // Hidden views park ordinary updates, but cannot retain withdrawn facts.
    // Publication receipts remain live across retained same-session panes.
    const [snapshot] = createSignal<{
      key: string;
      value: ControlUiSessionPullRequestSnapshot | undefined;
    }>((previous) => {
      revision();
      const current = runtime.store.get(key);
      if (context.presented || current === undefined || current.discardPrevious) {
        return { key, value: current };
      }
      return previous?.key === key ? previous : { key, value: undefined };
    });
    const content = createMemo(() => {
      revision();
      return readPresentation(snapshot().value);
    });
    return (
      <PresentationContext value={locale}>
        <NativeContext value={native}>
          <RepositoryCiContext
            value={{
              requests: initial.host.requests,
              agentId: initial.host.sessions.agentId,
              isPresented: () => context.presented,
              isCurrent(target) {
                if (context.signal.aborted || target.sessionKey !== key) {
                  return false;
                }
                const value = context.props.facts;
                const facts = value?.readCurrent ? value.readCurrent() : value;
                if (target.sessionId && facts?.session?.sessionId !== target.sessionId) {
                  return false;
                }
                return (
                  !target.pullRequest ||
                  runtime.store
                    .get(key)
                    ?.pullRequests.some(
                      (pr) =>
                        pr.owner === target.pullRequest!.owner &&
                        pr.repo === target.pullRequest!.repo &&
                        pr.number === target.pullRequest!.number &&
                        (target.pullRequest!.headSha === undefined ||
                          pr.headSha === target.pullRequest!.headSha),
                    ) === true
                );
              },
            }}
          >
            {mobile ? (
              <MobileSessionContent
                placement={mobile}
                context={viewContext()}
                content={content()}
                snapshot={(revision(), runtime.store.get(key))}
                onDismiss={dismissPullRequest}
                onDismissBranch={(branch) => {
                  if (!currentPresentation()) {
                    return false;
                  }
                  const currentBranch = runtime.store.get(key)?.branch;
                  if (!currentBranch || chatBranchId(currentBranch) !== chatBranchId(branch)) {
                    return false;
                  }
                  context.signal.throwIfAborted();
                  dismissChatPullRequest(
                    browserDismissalStorage(),
                    context.props.sessionKey,
                    chatBranchId(branch),
                  );
                  changed();
                  return true;
                }}
                onRetry={() => runtime.store.refresh(key)}
              />
            ) : (
              <Show
                when={environment}
                fallback={
                  <ChatPullRequests
                    pullRequests={content().pullRequests}
                    branch={content().branch}
                    branchDismissed={content().branchDismissed}
                    status={content().status}
                    sessionKey={(revision(), key)}
                    sessionId={viewContext().props.facts?.session?.sessionId}
                    presented={viewContext().presented}
                    compact={viewContext().props.compact}
                    dismissed={viewContext().props.dismissed}
                    publication={content().publication}
                    onDismiss={dismissPullRequest}
                    onDismissBranch={(branch) => {
                      if (!currentPresentation()) {
                        return;
                      }
                      const id = chatBranchId(branch);
                      const currentBranch = runtime.store.get(key)?.branch;
                      if (!currentBranch || chatBranchId(currentBranch) !== id) {
                        return;
                      }
                      context.signal.throwIfAborted();
                      dismissChatPullRequest(
                        browserDismissalStorage(),
                        context.props.sessionKey,
                        id,
                      );
                      changed();
                    }}
                    onOpenSessionDiff={viewContext().props.onOpenSessionDiff}
                    publishedOnly
                  />
                }
              >
                <RepositoryEnvironment
                  {...content()}
                  worktree={Boolean(viewContext().props.facts?.session?.worktree)}
                  sessionKey={(revision(), key)}
                  presented={viewContext().presented}
                  onOpenSessionDiff={viewContext().props.onOpenSessionDiff}
                  onDismissBranch={(branch) => {
                    if (!currentPresentation()) {
                      return;
                    }
                    const current = runtime.store.get(key)?.branch;
                    if (!current || chatBranchId(current) !== chatBranchId(branch)) {
                      return;
                    }
                    context.signal.throwIfAborted();
                    dismissChatPullRequest(
                      browserDismissalStorage(),
                      context.props.sessionKey,
                      chatBranchId(branch),
                    );
                    changed();
                  }}
                />
              </Show>
            )}
          </RepositoryCiContext>
        </NativeContext>
      </PresentationContext>
    );
  }, container);
  const stopHost = initial.host.subscribe(sync);
  const stopStore = runtime.store.subscribe(changed);
  sync();
  return {
    update(next: Parameters<ControlUiSessionAccessory["mount"]>[1]) {
      context = next;
      sync();
    },
    dispose() {
      stopHost();
      stopStore();
      runtime.store.unwatch(owner);
      publication.dispose();
      stop();
    },
  };
}
