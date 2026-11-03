/** @jsxImportSource @solidjs/web */
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
} from "@openclaw/gateway-protocol";
import type { ControlUiLinkReaderPreview } from "openclaw/plugin-sdk/control-ui-link-reader";
import { For, Show, useContext } from "solid-js";
import { content, hostControl } from "./host-control.tsx";
import { SessionGitDiff } from "./native-components.tsx";
import { Icon } from "./presentation-components.tsx";
import { PresentationContext, presentationTranslator } from "./presentation-context.ts";
import { sessionPullRequestStateIcons } from "./session-pull-request-presentation.ts";

export function ActivityRead(props: {
  branch?: ControlUiSessionBranch;
  pullRequests: readonly ControlUiSessionPullRequest[];
  stale: boolean;
  sessionKey?: string;
  agentId?: string;
}) {
  const t = presentationTranslator();
  const presentation = useContext(PresentationContext);
  const preview = (pr: ControlUiSessionPullRequest): ControlUiLinkReaderPreview => ({
    url: pr.url,
    title: pr.title,
    subtitle: `${pr.owner}/${pr.repo} #${pr.number}`,
    badge: {
      label: t(`activity.git.${pr.state}`),
      tone:
        pr.state === "merged"
          ? "accent"
          : pr.state === "open"
            ? "positive"
            : pr.state === "closed"
              ? "negative"
              : "neutral",
    },
    author: pr.author?.login,
    authorUrl: pr.author?.login
      ? `https://github.com/${encodeURIComponent(pr.author.login)}`
      : undefined,
    metadata: [
      ...(pr.additions === undefined
        ? []
        : [{ label: "", value: `+${pr.additions}`, tone: "positive" as const }]),
      ...(pr.deletions === undefined
        ? []
        : [{ label: "", value: `−${pr.deletions}`, tone: "negative" as const }]),
    ],
  });
  const child = content(() => (
    <div class="activity-feed__git">
      <Show when={props.branch}>
        {(branch) => (
          <span
            class="activity-feed__branch"
            title={t("activity.git.branchDiff", { branch: branch().branch })}
          >
            <span class="activity-feed__git-icon" aria-hidden="true">
              <Icon name="gitBranch" />
            </span>
            <span class="activity-feed__git-label">{branch().branch}</span>
            <SessionGitDiff classPrefix="activity-feed" item={branch()} />
          </span>
        )}
      </Show>
      <For each={props.pullRequests} keyed={(pr) => pr.url}>
        {(pr) => (
          <a
            class="activity-feed__pr"
            data-state={pr().state}
            href={pr().url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t("activity.git.pullRequest", {
              repository: `${pr().owner}/${pr().repo}`,
              number: String(pr().number),
              title: pr().title,
              state: t(`activity.git.${pr().state}`),
            })}
          >
            <span class="activity-feed__git-icon" aria-hidden="true">
              <Icon name={sessionPullRequestStateIcons[pr().state]} />
            </span>
            <span class="activity-feed__git-label">
              {pr().repo}#{pr().number}
            </span>
            <SessionGitDiff classPrefix="activity-feed" item={pr()} />
          </a>
        )}
      </For>
      <Show when={props.stale}>
        <span
          class="activity-feed__git-stale"
          role="img"
          aria-label={t("activity.git.stale")}
          title={t("activity.git.stale")}
        >
          <Icon name="alertTriangle" />
        </span>
      </Show>
    </div>
  ));
  return hostControl(
    () => ({
      child,
      previewSeeds: props.pullRequests.map(preview),
      sessionKey: props.sessionKey,
      agentId: props.agentId,
    }),
    presentation.mountLinkPreviews,
  );
}
