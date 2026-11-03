/** @jsxImportSource @solidjs/web */
import { Show } from "solid-js";
import { ChatBranchActions } from "./chat-branch-actions.tsx";
import type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";
import { SessionGitDiff } from "./native-components.tsx";
import { Icon, createTextOverflow } from "./presentation-components.tsx";
import { presentationTranslator } from "./presentation-context.ts";
import { repositoryEnvironmentWork, showWorkRow } from "./pull-request-dismissal.ts";

/** Repository work contributes to the native Environment; completed PRs stay in Context. */
export function RepositoryEnvironment(props: ChatPullRequestsProps & { worktree: boolean }) {
  const t = presentationTranslator();
  const work = () => repositoryEnvironmentWork(props);
  // The branch fact remains after its publication controls are dismissed or completed.
  const controls = () => props.publication?.result?.status !== "published" && showWorkRow(props);
  return (
    <Show when={work()}>
      {(value) => (
        <div class="chat-environment__branch repository-environment">
          <div class="chat-details__row chat-environment__row" title={value().branch?.branch}>
            <span class="repository-environment__icon">
              <Icon name={value().branch ? "gitBranch" : "gitPullRequest"} />
            </span>
            <span
              ref={createTextOverflow(() => value().branch?.branch)}
              class="chat-environment__branch-name"
            >
              {value().branch?.branch ?? t("chat.pullRequests.publishPr")}
            </span>
            <Show when={props.worktree}>
              <small class="chat-details__badge">{t("chat.sessionDetails.worktree")}</small>
            </Show>
          </div>
          <Show when={controls()}>
            <div class="chat-environment__branch-controls">
              <Show
                when={value().branch && (value().branch?.additions || value().branch?.deletions)}
              >
                <SessionGitDiff
                  classPrefix="chat-pr"
                  item={value().branch!}
                  onOpen={props.onOpenSessionDiff}
                />
              </Show>
              <ChatBranchActions
                branch={value().branch}
                branchName={value().branch?.branch ?? t("chat.pullRequests.publishPr")}
                status={value().status}
                publication={value().publication}
                presented={
                  typeof props.presented === "object"
                    ? props.presented.isPresented()
                    : (props.presented ?? true)
                }
                onDismiss={value().onDismissBranch}
              />
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}
