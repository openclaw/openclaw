/** @jsxImportSource @solidjs/web */

import type { ControlUiSessionPullRequestSnapshot } from "@openclaw/gateway-protocol";
import { createMemo, onCleanup, For, Show } from "solid-js";
import { Icon } from "./presentation-components.tsx";
import { presentationTranslator } from "./presentation-context.ts";
import {
  displaySessionPullRequests,
  type SessionDisplayPullRequest,
  sessionPullRequestStateIcons,
} from "./session-pull-request-presentation.ts";

const MAX_VISIBLE_PULL_REQUESTS = 10;

const formatGitHubItemReference = (item: { owner: string; repo: string; number: number }) =>
  `${item.owner}/${item.repo}#${item.number}`;

function PullRequestRow(props: {
  request: SessionDisplayPullRequest;
  registerControls?: RegisterControls;
}) {
  const t = presentationTranslator();
  const state = () =>
    props.request.state
      ? t(`sessionHovercard.states.${props.request.state}`)
      : t("sessionHovercard.stateUnavailable");
  const checks = () =>
    props.request.checks ? t(`sessionHovercard.checks.${props.request.checks.state}`) : null;
  const details = () =>
    [
      state(),
      checks(),
      props.request.additions === undefined ? null : `+${props.request.additions.toLocaleString()}`,
      props.request.deletions === undefined ? null : `−${props.request.deletions.toLocaleString()}`,
      props.request.sourceSessionKey
        ? t("sessionHovercard.taskBranch", { branch: props.request.branch })
        : null,
    ].filter((detail): detail is string => Boolean(detail));
  const stateLabel = () => (checks() ? `${state()} · ${checks()}` : state());
  return (
    <a
      ref={controlRef(() => props.registerControls)}
      class="session-hovercard__pr-row"
      data-state={props.request.state}
      href={props.request.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${t("chat.pullRequests.linkLabel", { reference: formatGitHubItemReference(props.request), title: props.request.title })}, ${details().join(", ")}`}
    >
      <span
        class="session-hovercard__pr-state-icon"
        role="img"
        data-checks={props.request.checks?.state}
        aria-label={stateLabel()}
        title={stateLabel()}
      >
        <Icon
          name={
            props.request.state
              ? sessionPullRequestStateIcons[props.request.state]
              : "gitPullRequest"
          }
        />
      </span>
      <span class="session-hovercard__pr-title">{props.request.title}</span>
      <Show
        when={props.request.checks?.state === "failing"}
        fallback={
          <Show
            when={props.request.checks?.state === "pending"}
            fallback={<span class="session-hovercard__pr-number">#{props.request.number}</span>}
          >
            <span class="session-run-spinner" aria-hidden="true" />
          </Show>
        }
      >
        <span class="session-hovercard__pr-checks">
          {t("sessionHovercard.checks.failingCount", {
            count: String(Math.max(1, props.request.checks?.failed ?? 0)),
          })}
        </span>
      </Show>
    </a>
  );
}

export function PullRequestDetails(props: {
  snapshot?: ControlUiSessionPullRequestSnapshot;
  registerControls?: RegisterControls;
}) {
  const t = presentationTranslator();
  const requests = createMemo(() => displaySessionPullRequests(props.snapshot));
  const visible = createMemo(() => requests().slice(0, MAX_VISIBLE_PULL_REQUESTS));
  const count = createMemo(
    () =>
      props.snapshot?.pullRequestCount ??
      Math.max(requests().length, props.snapshot?.taskPullRequestCount ?? 0),
  );
  const remaining = createMemo(() => Math.max(0, count() - visible().length));
  return (
    <>
      <Show when={requests().length > 0}>
        <div class="session-hovercard__pr-list">
          <div class="session-hovercard__section-title">
            <span>{t("sessionHovercard.pullRequests")}</span>
            <span class="session-hovercard__pr-count">{count()}</span>
          </div>
          <For each={visible()} keyed={(request) => request.url}>
            {(request) => (
              <PullRequestRow request={request()} registerControls={props.registerControls} />
            )}
          </For>
          <Show when={remaining() > 0}>
            <div class="session-hovercard__more">
              {t("sessionHovercard.morePullRequests", {
                count: String(remaining()),
              })}
            </div>
          </Show>
        </div>
      </Show>
    </>
  );
}

type RegisterControls = (read: () => readonly HTMLElement[]) => () => void;
function controlRef(read: () => RegisterControls | undefined) {
  let stop: (() => void) | undefined;
  onCleanup(() => stop?.());
  return (element: HTMLElement) => {
    stop?.();
    stop = read()?.(() => [element]);
  };
}
