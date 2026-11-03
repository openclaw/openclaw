import {
  appendNativeGitHubPublicationMessage as appendGitHubPublicationMessage,
  type NativeGitHubPublicationContentFactsV1 as RepositoryPublicationContentFactsV1,
} from "openclaw/plugin-sdk/native-github-publication-host";

/** GitHub owns text and markers; the host owns credit and optional session disclosure. */
export function formatGitHubPublicationContent(params: {
  requestId: string;
  title?: string;
  branch: string;
  description: string;
  facts: RepositoryPublicationContentFactsV1;
}) {
  const description = params.description
    .replace(/(?:\s*---\s*\n\[View the OpenClaw team session\]\([^\r\n)]*\)\s*)+$/u, "")
    .replace(
      /(?:^|\n\n)## Worked on by\n\n(?:- @[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\n)*- @[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?=\n\n|$)/gu,
      "",
    )
    .trimEnd();
  const title = params.title?.trim() || `Publish ${params.branch}`;
  const trailers = params.facts.credit.trailers;
  const credit = params.facts.credit.logins.map((login) => `- @${login}`).join("\n");
  return {
    title,
    trailers,
    commitMessage: `${appendGitHubPublicationMessage(
      credit ? `${title}\n\nWorked on by:\n${credit}` : title,
      [...trailers, `OpenClaw-Publication: ${params.requestId}`],
    )}\n`,
    assertCurrent(this: void) {
      params.facts.assertCurrent();
    },
    pullRequestBody() {
      const participants = credit ? `\n\n## Worked on by\n\n${credit}` : "";
      const sessionUrl = params.facts.currentSessionUrl();
      const footer = sessionUrl ? `\n\n---\n[View the OpenClaw team session](${sessionUrl})` : "";
      const body = `${description}${participants}\n\n<!-- openclaw-publication:${params.requestId} -->`;
      return `${params.facts.appendAttribution?.(body) ?? body}${footer}`;
    },
  };
}
