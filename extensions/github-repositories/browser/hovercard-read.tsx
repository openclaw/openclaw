/** @jsxImportSource @solidjs/web */

import type { ControlUiSessionPullRequestSnapshot } from "@openclaw/gateway-protocol";
import { createMemo, onCleanup, For, Show } from "solid-js";
import { SessionGitDiff } from "./native-components.tsx";
import { Icon } from "./presentation-components.tsx";
import { presentationTranslator } from "./presentation-context.ts";
import {
  displaySessionPullRequests,
  type SessionDisplayPullRequest,
  sessionPullRequestStateIcons,
} from "./session-pull-request-presentation.ts";

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
      <span class="session-hovercard__pr-main">
        <span class="session-hovercard__pr-title">{props.request.title}</span>
        <span class="session-hovercard__pr-meta">
          <span class="session-hovercard__pr-number">
            {formatGitHubItemReference(props.request)}
          </span>
          <span class="session-hovercard__pr-state">{state()}</span>
          <SessionGitDiff classPrefix="session-hovercard" item={props.request} />
        </span>
        <Show when={checks()}>
          <span class="session-hovercard__pr-checks" data-checks={props.request.checks?.state}>
            {checks()}
          </span>
        </Show>
        <Show when={props.request.sourceSessionKey}>
          <span class="session-hovercard__pr-source">
            {t("sessionHovercard.taskBranch", { branch: props.request.branch })}
          </span>
        </Show>
      </span>
    </a>
  );
}

export function PullRequestDetails(props: {
  snapshot?: ControlUiSessionPullRequestSnapshot;
  registerControls?: RegisterControls;
}) {
  const t = presentationTranslator();
  const branch = () => props.snapshot?.branch;
  const requests = createMemo(() => displaySessionPullRequests(props.snapshot));
  const count = createMemo(
    () =>
      props.snapshot?.pullRequestCount ??
      Math.max(requests().length, props.snapshot?.taskPullRequestCount ?? 0),
  );
  const remaining = createMemo(() => Math.max(0, count() - requests().length));
  const branchLabel = () =>
    t("chat.pullRequests.createPrLabel", { branch: branch()?.branch ?? "" });
  return (
    <>
      <Show when={branch() && !props.snapshot?.pullRequests.length}>
        <div class="session-hovercard__branch-row">
          <span class="session-hovercard__branch-icon" aria-hidden="true">
            <Icon name="gitBranch" />
          </span>
          <Show
            when={branch()?.createUrl}
            fallback={
              <span class="session-hovercard__branch-label">{t("chat.sessionDiff.title")}</span>
            }
          >
            <a
              ref={controlRef(() => props.registerControls)}
              class="session-hovercard__branch-action"
              href={branch()?.createUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={branchLabel()}
              title={branchLabel()}
            >
              {t("chat.pullRequests.createPr")}
            </a>
          </Show>
          <SessionGitDiff classPrefix="session-hovercard" item={branch() ?? {}} />
        </div>
      </Show>
      <Show when={requests().length > 0}>
        <div class="session-hovercard__pr-list">
          <div class="session-hovercard__pr-heading">
            <span>{t("sessionHovercard.pullRequests")}</span>
            <span class="session-hovercard__pr-count">{count()}</span>
          </div>
          <For each={requests()} keyed={(request) => request.url}>
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
