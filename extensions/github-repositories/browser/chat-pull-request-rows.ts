import type { ControlUiSessionPullRequest } from "@openclaw/gateway-protocol";
import type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";
import { orderSessionPullRequests } from "./session-pull-request-presentation.ts";

const formatGitHubItemReference = (item: { owner: string; repo: string; number: number }) =>
  `${item.owner}/${item.repo}#${item.number}`;

export type PullRequestRowEntry = {
  url: string;
  branch: string;
  reference: string;
  details?: ControlUiSessionPullRequest;
};

export function chatPullRequestRows(
  props: Pick<ChatPullRequestsProps, "pullRequests" | "publishedOnly" | "publication">,
): PullRequestRowEntry[] {
  const rows: PullRequestRowEntry[] = orderSessionPullRequests(props.pullRequests).map(
    (details) => ({
      url: details.url,
      branch: details.branch,
      reference: formatGitHubItemReference(details),
      details,
    }),
  );
  const receipt =
    props.publication?.result?.status === "published" ? props.publication.result : undefined;
  if (props.publishedOnly && receipt && !rows.some((row) => row.url === receipt.url)) {
    rows.push({ url: receipt.url, branch: receipt.branch, reference: receipt.repository });
  }
  return rows;
}
