/** @jsxImportSource @solidjs/web */

import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "@openclaw/gateway-protocol";
import { Errored, For, latest, Show } from "solid-js";
import type { createPullRequestCopy } from "./chat-pull-request-copy.ts";
import type { GitHubPublicationView } from "./github-publication-owner.ts";
import type { PresentationValue } from "./native-context.tsx";
import { Icon, Tooltip } from "./presentation-components.tsx";
import { presentationTranslator } from "./presentation-context.ts";

export type ChatPullRequestsProps = {
  pullRequests: ControlUiSessionPullRequest[];
  sessionKey?: string;
  sessionId?: string;
  presented?: PresentationValue;
  dismissed?: boolean;
  branch?: ControlUiSessionBranch;
  /** Hides the branch row and its idle publish offer; retained publication outcomes stay visible. */
  branchDismissed?: boolean;
  status: ControlUiSessionPullRequestSnapshot["status"];
  onDismiss: (pullRequest: ControlUiSessionPullRequest) => void;
  onDismissBranch?: (branch: ControlUiSessionBranch) => void;
  onOpenSessionDiff?: () => void;
  publication?: GitHubPublicationView;
  /** Compact row in the user-opened Details surface; actions keep their owners. */
  compact?: boolean;
  /** Keep publication work in Environment; only completed receipts and PRs belong here. */
  publishedOnly?: boolean;
};
export const STATE_LABEL_KEYS = {
  merged: "chat.pullRequests.merged",
  draft: "chat.pullRequests.draft",
  closed: "chat.pullRequests.closed",
  open: "chat.pullRequests.open",
} as const;
const CHECK_ROW_LABELS = {
  failed: "chat.pullRequests.checksFailed",
  passed: "chat.pullRequests.checksPassed",
  running: "chat.pullRequests.checksRunning",
  skipped: "chat.pullRequests.checksSkipped",
} as const;

export function PullRequestCopyError(props: {
  clipboard: ReturnType<typeof createPullRequestCopy>;
}) {
  const t = presentationTranslator();
  return (
    <Show when={!props.clipboard.copying()}>
      <Errored
        fallback={
          <p class="chat-pr-menu__error" role="alert">
            {t("chat.pullRequests.copyFailed")}
          </p>
        }
      >
        {latest(props.clipboard.outcome)}
      </Errored>
    </Show>
  );
}

export function ChecksRows(props: {
  checks: ControlUiSessionPullRequest["checks"];
  runningFirst?: boolean;
}) {
  const t = presentationTranslator();
  const order = () =>
    props.runningFirst
      ? (["failed", "running", "passed", "skipped"] as const)
      : (["failed", "passed", "running", "skipped"] as const);
  return (
    <For each={order()}>
      {(kind) => (
        <Show when={(props.checks?.[kind] ?? 0) !== 0}>
          <div class={["chat-pr__checks-row", `chat-pr__checks-row--${kind}`]}>
            <span class="chat-pr__check-symbol" aria-hidden="true">
              <Show when={kind !== "running"} fallback={<span class="btn__spinner" />}>
                <Icon name={kind === "failed" ? "x" : kind === "passed" ? "check" : "circle"} />
              </Show>
            </span>
            <span class="chat-pr__checks-row-label">{t(CHECK_ROW_LABELS[kind])}</span>
            <span class="chat-pr__checks-row-count">{props.checks?.[kind] ?? 0}</span>
          </div>
        </Show>
      )}
    </For>
  );
}

export function StatusWarning(props: {
  status: ControlUiSessionPullRequestSnapshot["status"];
  text?: boolean;
}) {
  const t = presentationTranslator();
  const message = () =>
    t(
      props.status === "rate-limited"
        ? "chat.pullRequests.rateLimited"
        : "chat.pullRequests.unavailable",
    );
  return (
    <Show when={props.status !== "ready"}>
      <Show
        when={props.text}
        fallback={
          <Tooltip content={message()}>
            <span class="chat-pr__warning" role="img" aria-label={message()}>
              <Icon name="alertTriangle" />
            </span>
          </Tooltip>
        }
      >
        <span class="chat-pr__stale">
          {t(
            props.status === "rate-limited"
              ? "chat.pullRequests.rateLimitedShort"
              : "chat.pullRequests.unavailableShort",
          )}
        </span>
      </Show>
    </Show>
  );
}
