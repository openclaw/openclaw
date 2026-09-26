import type { ControlUiLinkReaderPreview } from "openclaw/plugin-sdk/control-ui-link-reader";
import type { ControlUiGitHubPreview } from "./preview-contract.js";
import { githubTargetUrl } from "./targets.js";

export function githubChangeMetadata(
  additions?: number,
  deletions?: number,
  files?: number,
  comments?: number,
): NonNullable<ControlUiLinkReaderPreview["metadata"]> {
  const metadata: NonNullable<ControlUiLinkReaderPreview["metadata"]> = [];
  if (additions !== undefined) {
    metadata.push({ label: "Additions", value: "+" + additions, tone: "positive" });
  }
  if (deletions !== undefined) {
    metadata.push({ label: "Deletions", value: "−" + deletions, tone: "negative" });
  }
  if (files !== undefined) {
    metadata.push({ label: "Files", value: String(files) });
  }
  if (comments !== undefined) {
    metadata.push({ label: "Comments", value: String(comments) });
  }
  return metadata;
}

export function githubPreviewView(preview: ControlUiGitHubPreview): ControlUiLinkReaderPreview {
  const badge: ControlUiLinkReaderPreview["badge"] = preview.mergedAt
    ? { label: "Merged", tone: "accent" }
    : preview.draft && preview.state === "open"
      ? { label: "Draft", tone: "neutral" }
      : preview.state === "open"
        ? { label: "Open", tone: "positive" }
        : preview.kind === "issue" && preview.stateReason !== "not_planned"
          ? { label: "Closed", tone: "accent" }
          : { label: "Closed", tone: "negative" };
  return {
    url: githubTargetUrl(preview),
    title: preview.title,
    subtitle: preview.owner + "/" + preview.repo + " #" + preview.number,
    badge: {
      ...badge,
      timestamp: preview.mergedAt ?? (preview.state === "closed" ? preview.closedAt : undefined),
    },
    author: preview.login,
    authorUrl: "https://github.com/" + encodeURIComponent(preview.login),
    coAuthors: preview.coAuthors?.map(({ login, avatarDataUrl }) => ({
      name: login,
      imageUrl: avatarDataUrl,
    })),
    coAuthorCount: preview.coAuthorCount,
    createdAt: preview.createdAt,
    updatedAt: preview.updatedAt,
    imageUrl: preview.avatarDataUrl,
    metadata:
      preview.kind === "pull"
        ? githubChangeMetadata(preview.additions, preview.deletions).map(({ value, tone }) => ({
            label: "",
            value,
            tone,
          }))
        : preview.comments === undefined
          ? []
          : [{ label: "Comments", value: String(preview.comments) }],
  };
}
