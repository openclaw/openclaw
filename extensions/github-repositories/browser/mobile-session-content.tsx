/** @jsxImportSource @solidjs/web */

import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "@openclaw/gateway-protocol";
import type { ControlUiSessionAccessory } from "openclaw/plugin-sdk/control-ui";
import { For, Show, createSignal, useContext } from "solid-js";
import { GitHubPublicationMobile } from "./chat-github-publication-mobile.tsx";
import {
  ChatPullRequestMobileRow,
  ChatPullRequestMobileRecovery,
  ChatPullRequestMobileCollection,
  ChatPullRequestMobileDetail,
  ChatPullRequestMobileChecks,
  ChatPullRequestMobileMonitoring,
} from "./chat-pull-request-mobile.tsx";
import type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";
import { content, hostControl } from "./host-control.tsx";
import { pullRequestView, publicationView } from "./mobile-activity-presentation.ts";
import { ContentPresentation } from "./native-context.tsx";
import { Icon } from "./presentation-components.tsx";
import { PresentationContext, presentationTranslator } from "./presentation-context.ts";
import {
  chatPullRequestId,
  publicationPullRequest,
  retainedPublication,
} from "./pull-request-dismissal.ts";

type Context = Parameters<ControlUiSessionAccessory["mount"]>[1];

/** Only vendor facts/actions live here; native Root/Back/focus and route ancestry stay with the pane. */
export function MobileSessionContent(props: {
  placement: "root" | "page" | "activity";
  context: Context;
  content: ChatPullRequestsProps;
  snapshot: ControlUiSessionPullRequestSnapshot | undefined;
  onDismiss: (request: ControlUiSessionPullRequest) => boolean;
  onDismissBranch: (branch: ControlUiSessionBranch) => boolean;
  onRetry: () => boolean;
}) {
  const t = presentationTranslator();
  const presentation = useContext(PresentationContext);
  const [requested, setRequested] = createSignal<{
    snapshot: ControlUiSessionPullRequestSnapshot | undefined;
  }>();
  const current = () => !props.context.signal.aborted && props.context.presented;
  const open = (id: string, title: string, source?: HTMLElement) => {
    if (current()) {
      props.context.props.onOpenDetailsPage?.({ id, title }, source);
    }
  };
  const openRequest = (request: ControlUiSessionPullRequest, source?: HTMLElement) => {
    if (props.content.pullRequests.includes(request)) {
      open(`pull-request:${chatPullRequestId(request)}`, request.title, source);
    }
  };
  const recovery = () => ({
    status: props.snapshot?.status ?? ("unavailable" as const),
    hasSnapshot: props.snapshot !== undefined,
    retrying: requested() !== undefined && requested()?.snapshot === props.snapshot,
    onRetry: () => {
      if (current() && props.onRetry()) {
        setRequested({ snapshot: props.snapshot });
      }
    },
  });
  const publicationVisible = () =>
    Boolean(
      props.content.publication &&
      !publicationPullRequest(props.content.publication, props.content.pullRequests) &&
      (props.placement === "activity"
        ? (!props.content.branchDismissed && props.content.branch) ||
          retainedPublication(props.content.publication)
        : !props.content.branchDismissed || retainedPublication(props.content.publication)),
    );
  const entry = (id: string, label: string) => (
    <button
      type="button"
      class="chat-details-mobile-root__entry"
      data-details-destination={id}
      disabled={!props.context.presented}
      onClick={(event) => open(id, label, event.currentTarget)}
    >
      <span class="chat-details-mobile-root__leading" aria-hidden="true">
        <Icon name={id === "publication" ? "gitBranch" : "gitPullRequest"} />
      </span>
      <span class="chat-details-mobile-root__copy">
        <span class="chat-details-mobile-root__label">{label}</span>
      </span>
      <Icon name="chevronRight" class="chat-details-mobile-root__chevron" />
    </button>
  );
  const page = () => props.context.props.detailsPage?.split(":")[0];
  const selected = () =>
    props.content.pullRequests.find(
      (request) =>
        chatPullRequestId(request) ===
        props.context.props.detailsPage?.split(":").slice(1).join(":"),
    );
  const dismiss = (request: ControlUiSessionPullRequest) => {
    if (current() && selected() === request && page() === "pull-request") {
      if (publicationPullRequest(props.content.publication, [request])) {
        void props.content.publication?.onNewAction?.();
      }
      if (props.onDismiss(request)) {
        props.context.props.onDetailsBack?.();
      }
    }
  };
  function Pill(input: {
    family: string;
    view: ReturnType<typeof pullRequestView>;
    onOpen: (source: HTMLButtonElement) => void;
    trailing?: HTMLElement;
  }) {
    return hostControl(
      () => ({
        family: input.family,
        view: input.view,
        onOpen: input.onOpen,
        trailing: input.trailing,
        registerButton: (button: HTMLButtonElement) =>
          props.context.props.registerControls?.(() => [button]) ?? (() => {}),
      }),
      presentation.mountActivityPill,
    );
  }
  return (
    <>
      <Show
        when={
          props.placement === "root" &&
          (props.content.pullRequests.length > 0 ||
            props.snapshot?.status !== "ready" ||
            publicationVisible())
        }
      >
        <section
          class="chat-details-mobile-root__section"
          data-details-group="pull-requests"
          aria-label={t("sessionHovercard.pullRequests")}
        >
          <h3 class="chat-details-mobile-root__heading">{t("sessionHovercard.pullRequests")}</h3>
          <div class="chat-details-mobile-root__group">
            <For
              each={props.content.pullRequests.slice(
                0,
                props.content.pullRequests.length > 3 ? 2 : 3,
              )}
              keyed={chatPullRequestId}
            >
              {(request) => (
                <ChatPullRequestMobileRow pullRequest={request()} onOpen={openRequest} />
              )}
            </For>
            <Show when={props.content.pullRequests.length > 3}>
              {entry("pull-requests", t("sessionHovercard.pullRequests"))}
            </Show>
            <ChatPullRequestMobileRecovery {...recovery()} collection />
            <Show when={publicationVisible()}>
              {entry("publication", t("chat.activityPills.publication.review"))}
            </Show>
          </div>
        </section>
      </Show>
      <Show when={props.placement === "activity"}>
        <For each={props.content.pullRequests} keyed={chatPullRequestId}>
          {(request) => (
            <Pill
              family="pull-request"
              view={pullRequestView(request(), props.content.status ?? "ready", t)}
              onOpen={(source) => openRequest(request(), source)}
              trailing={content(() => (
                <Show
                  when={props.content.status === "ready" && props.content.pullRequests.length === 1}
                  fallback={
                    <Show when={props.content.status !== "ready"}>
                      <span class="activity-pill__problem" aria-hidden="true">
                        <Icon name="alertTriangle" />
                      </span>
                    </Show>
                  }
                >
                  <span class="activity-pill__diff">
                    <Show when={request().additions !== undefined}>
                      <span class="activity-pill__additions">+{request().additions}</span>
                    </Show>
                    <Show when={request().deletions !== undefined}>
                      <span class="activity-pill__deletions">−{request().deletions}</span>
                    </Show>
                  </span>
                </Show>
              ))}
            />
          )}
        </For>
        <Show when={publicationVisible() && props.content.publication}>
          {(publication) => (
            <Pill
              family="publication"
              view={publicationView(publication(), t)}
              onOpen={(source) => open("publication", t("chat.pullRequests.publishPr"), source)}
            />
          )}
        </Show>
      </Show>
      <Show when={props.placement === "page"}>
        <For each={["pull-requests", "pull-request", "checks", "monitoring", "publication"]}>
          {(kind) => {
            const presented = () => props.context.presented && page() === kind;
            return (
              <ContentPresentation value={presented}>
                <div data-repository-page={kind} hidden={page() !== kind} inert={!presented()}>
                  <Show when={kind === "pull-requests"}>
                    <ChatPullRequestMobileCollection
                      {...recovery()}
                      pullRequests={props.content.pullRequests}
                      onOpen={openRequest}
                    />
                  </Show>
                  <Show when={kind === "pull-request"}>
                    <ChatPullRequestMobileDetail
                      {...recovery()}
                      pullRequest={selected()}
                      onOpenChecks={() => {
                        const request = selected();
                        if (request) {
                          open(
                            `checks:${chatPullRequestId(request)}`,
                            t("chat.pullRequests.checksTitle"),
                          );
                        }
                      }}
                      onOpenMonitoring={() => {
                        const request = selected();
                        if (request) {
                          open(
                            `monitoring:${chatPullRequestId(request)}`,
                            t("chat.pullRequests.ciMonitoring"),
                          );
                        }
                      }}
                      onDismiss={dismiss}
                    />
                  </Show>
                  <Show when={kind === "checks"}>
                    <ChatPullRequestMobileChecks
                      {...recovery()}
                      pullRequest={selected()}
                      sessionKey={props.context.host.sessions.artifactKey(props.context.props)}
                      presented={presented()}
                    />
                  </Show>
                  <Show when={kind === "monitoring"}>
                    <ChatPullRequestMobileMonitoring
                      {...recovery()}
                      pullRequest={selected()}
                      sessionKey={props.context.host.sessions.artifactKey(props.context.props)}
                      sessionId={props.context.props.facts?.session?.sessionId}
                      presented={presented()}
                    />
                  </Show>
                  <Show when={kind === "publication" && props.content.publication}>
                    {(publication) => (
                      <GitHubPublicationMobile
                        publication={publication()}
                        presented={presented()}
                        branch={props.content.branch}
                        repository={props.snapshot?.repository}
                        onDismissBranch={(branch) => {
                          if (
                            current() &&
                            page() === "publication" &&
                            branch === props.content.branch &&
                            !props.content.branchDismissed &&
                            !retainedPublication(props.content.publication) &&
                            props.content.publication?.activity === null
                          ) {
                            if (props.onDismissBranch(branch)) {
                              props.context.props.onDetailsBack?.();
                            }
                          }
                        }}
                      />
                    )}
                  </Show>
                </div>
              </ContentPresentation>
            );
          }}
        </For>
      </Show>
    </>
  );
}
