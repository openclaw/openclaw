import { html } from "lit";
import { githubMark } from "./brand-mark.js";
import { parseGitHubLinkTarget } from "./link-target.js";
import type { GitHubPresentationHost } from "./presentation-host.js";

export function renderGitHubLinkPreviewSource(href: string, t: GitHubPresentationHost["t"]) {
  const item = parseGitHubLinkTarget(href);
  return item
    ? html`${githubMark}<span
          >${t(item.kind === "pull" ? "linkReader.previewPullRequest" : "linkReader.previewIssue", { number: String(item.number) })}</span
        >`
    : null;
}
