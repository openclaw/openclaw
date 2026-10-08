import type {
  SessionGitHubOptionsResultSchema,
  SessionGitHubPublicationResultSchema,
  SessionGitHubPublishParamsSchema,
  SessionGitHubStatusResultSchema,
} from "@openclaw/gateway-protocol";
import type { Static } from "typebox";

export type GitHubPublicationOptions = Static<typeof SessionGitHubOptionsResultSchema>;
export type GitHubPublicationSelection = NonNullable<
  Static<typeof SessionGitHubPublishParamsSchema>["selection"]
>;
type SessionGitHubPublicationResult = Static<typeof SessionGitHubPublicationResultSchema>;
type SessionGitHubStatusResult = Static<typeof SessionGitHubStatusResultSchema>;
type GitHubPublicationPublisher = NonNullable<SessionGitHubPublicationResult["publisher"]>;
type GitHubPublicationActivity = "read" | "publish" | "confirm";

export type GitHubPublicationView = {
  activity: GitHubPublicationActivity | null;
  canPublishShared: boolean;
  canPublishPersonal: boolean;
  locked: boolean;
  options: GitHubPublicationOptions | null;
  selection: GitHubPublicationSelection | null;
  result: SessionGitHubPublicationResult | null;
  confirmation: SessionGitHubStatusResult["confirmation"];
  error: string | null;
  personalReady: boolean;
  onSelect?: (source: "shared" | "personal") => void;
  onPublish?: () => void;
  onConfirm?: () => void;
  onRefresh: () => void;
  onNewAction?: () => void;
};

export function selectedGitHubPublisher(
  selection: GitHubPublicationSelection | null,
): GitHubPublicationPublisher | undefined {
  return selection?.source === "personal"
    ? { source: "personal", ...selection.account }
    : selection?.expected;
}

export function personalGitHubPublicationSelection(
  options: GitHubPublicationOptions | null,
): Extract<GitHubPublicationSelection, { source: "personal" }> | null {
  const personal = options?.personal;
  return personal?.state === "connected" && personal.account && personal.generation
    ? { source: "personal", account: personal.account, generation: personal.generation }
    : null;
}

export type {
  ControlUiSessionPullRequestCheckStep,
  ControlUiSessionPullRequestCheck,
  ControlUiSessionPullRequestCheckDetails,
  ControlUiSessionPullRequest,
  ControlUiSessionBranch,
  ControlUiSessionPullRequestSnapshot,
} from "@openclaw/gateway-protocol";
