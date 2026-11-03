/** @jsxImportSource @solidjs/web */

import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequests,
} from "@openclaw/gateway-protocol";
import { createMemo, Show } from "solid-js";
import {
  GitHubPublicationAccountSelector,
  GitHubPublicationAction,
  GitHubPublicationDetails,
  GitHubPublicationMobileRefresh,
} from "./chat-github-publication.tsx";
import type { GitHubPublicationView } from "./github-publication-owner.ts";
import { SessionGitDiff } from "./native-components.tsx";
import type { PresentationValue } from "./native-context.tsx";
import { Icon } from "./presentation-components.tsx";
import { presentationTranslator } from "./presentation-context.ts";
import "./github-publication-mobile.css";

export type GitHubPublicationMobileProps = {
  publication: GitHubPublicationView;
  presented: PresentationValue;
  branch?: ControlUiSessionBranch | null;
  repository?: ControlUiSessionPullRequests["repository"];
  onDismissBranch?: (branch: ControlUiSessionBranch) => void;
};

/** Sheet body only. The mobile host owns its header, history, focus and scrollport. */
export function GitHubPublicationMobile(props: GitHubPublicationMobileProps) {
  const t = presentationTranslator();
  const context = createMemo<
    | {
        repository: string;
        branch?: string;
        baseBranch?: string;
        diff?: ControlUiSessionBranch;
      }
    | undefined
  >(() => {
    const { result, confirmation, locked } = props.publication;
    if (result?.status === "published") {
      return { repository: result.repository, branch: result.branch };
    }
    if (confirmation) {
      return {
        repository: confirmation.repository,
        branch: confirmation.branch,
        baseBranch: confirmation.baseBranch,
      };
    }
    // A retained attempt need not describe today's checkout. Never attach a new
    // branch or live diff to an accepted request whose snapshot is unavailable.
    if (locked || result) {
      return undefined;
    }
    const branch = props.branch;
    const repository = branch ?? props.repository;
    return repository
      ? {
          repository: `${repository.owner}/${repository.repo}`,
          branch: branch?.branch,
          diff: branch ?? undefined,
        }
      : undefined;
  });
  return (
    <div class="github-publication-mobile">
      <Show when={context()}>
        {(value) => (
          <div class="github-publication-mobile__context">
            <div class="github-publication-mobile__repository">{value().repository}</div>
            <Show when={value().branch}>
              {(branch) => (
                <div class="github-publication-mobile__branch-group">
                  <div class="github-publication-mobile__branch">
                    <Icon name="gitBranch" />
                    <span>{branch()}</span>
                    <Show when={value().baseBranch}>
                      {(base) => (
                        <>
                          <Icon name="arrowRight" />
                          <span>{base()}</span>
                        </>
                      )}
                    </Show>
                  </div>
                  <Show when={value().diff}>
                    {(diff) => <SessionGitDiff item={diff()} classPrefix="chat-pr" />}
                  </Show>
                </div>
              )}
            </Show>
          </div>
        )}
      </Show>
      <section
        class="github-publication-mobile__publication"
        aria-label={t("githubPublication.title")}
      >
        <div class="github-publication-mobile__heading">
          <h3>{t("githubPublication.title")}</h3>
          <GitHubPublicationMobileRefresh publication={props.publication} />
        </div>
        <GitHubPublicationAccountSelector
          publication={props.publication}
          presented={props.presented}
          mobile
        />
        <div class="github-publication-mobile__status" aria-live="polite">
          <GitHubPublicationDetails publication={props.publication} inline mobile />
          <Show when={props.publication.optionsUnavailable}>
            <div role="alert" class="github-publication-mobile__unavailable">
              <span>{t("githubPublication.statusUnavailable")}</span>
              <Show when={props.publication.error}>{(error) => <span>{error()}</span>}</Show>
            </div>
          </Show>
        </div>
        <Show when={!props.publication.optionsUnavailable}>
          <div class="github-publication-mobile__actions">
            <GitHubPublicationAction
              publication={props.publication}
              presented={props.presented}
              mobile
            />
          </div>
        </Show>
      </section>
      <Show
        when={
          props.branch &&
          props.onDismissBranch &&
          !props.publication.locked &&
          !props.publication.result
        }
      >
        <div class="chat-pr-mobile__group chat-pr-mobile__actions">
          <button
            type="button"
            class="chat-pr-mobile__hide"
            aria-label={t("chat.pullRequests.dismissBranch", {
              branch: props.branch?.branch ?? "",
            })}
            disabled={props.publication.activity !== null}
            onClick={() => {
              const presented = props.presented;
              if (
                props.branch &&
                !props.publication.locked &&
                !props.publication.result &&
                props.publication.activity === null &&
                (typeof presented === "object" ? presented.isPresented() : presented)
              ) {
                props.onDismissBranch?.(props.branch);
              }
            }}
          >
            <Icon name="eyeOff" />
            <span>{t("chat.pullRequests.hide")}</span>
          </button>
        </div>
      </Show>
    </div>
  );
}
