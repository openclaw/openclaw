import { parseGitHubLinkParams } from "@openclaw/github/targets-api.js";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";
import type { GitHubPublicationView } from "./github-publication-owner.ts";
import { chatPullRequestId } from "./pull-request-ids.ts";
export { chatPullRequestId, chatBranchId } from "./pull-request-ids.ts";

const DISMISSED_STORAGE_KEY = "openclaw.chat.dismissedPullRequests";
// Bounds localStorage growth: dismissals for the oldest sessions fall off
// once this many sessions have dismissed chips.
const DISMISSED_SESSION_LIMIT = 20;

/** The plugin retains its existing browser preference key and privacy-mode behavior. */
export function browserDismissalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function retainedPublication(publication: GitHubPublicationView | undefined) {
  return (
    publication?.result ||
    publication?.locked ||
    (publication?.error && !publication.optionsUnavailable)
  );
}

/** A published receipt bridges the PR until its independent snapshot arrives. */
export function publicationPullRequestTarget(publication: GitHubPublicationView | undefined) {
  const result = publication?.result;
  const url = result?.status === "published" ? URL.parse(result.url) : null;
  const target = url ? parseGitHubLinkParams({ url: url.href }, url.hostname)?.target : undefined;
  return target?.kind === "pull" ? target : undefined;
}

export function publicationPullRequest(
  publication: GitHubPublicationView | undefined,
  pullRequests: readonly Parameters<typeof chatPullRequestId>[0][],
) {
  const target = publication?.error ? undefined : publicationPullRequestTarget(publication);
  const id = target && chatPullRequestId(target);
  return id ? pullRequests.find((request) => chatPullRequestId(request) === id) : undefined;
}

export function showWorkRow(props: ChatPullRequestsProps): boolean {
  return Boolean(
    (!props.branchDismissed && props.branch) ||
    (!props.pullRequests.length &&
      (retainedPublication(props.publication) ||
        (!props.branchDismissed &&
          props.publication?.canPublishShared &&
          !props.publication.canPublishPersonal &&
          props.publication.options?.shared))),
  );
}

/** The current checkout's work stays in Environment until a completed PR owns its result. */
export function repositoryEnvironmentWork(
  props: ChatPullRequestsProps,
): ChatPullRequestsProps | undefined {
  if (props.branch) {
    return props;
  }
  if (
    props.publication?.result?.status === "published" ||
    (!props.branch &&
      !props.publication?.locked &&
      props.pullRequests.some((pr) => pr.state === "open" || pr.state === "draft"))
  ) {
    return undefined;
  }
  return showWorkRow(props) || retainedPublication(props.publication) ? props : undefined;
}

export function hasChatPullRequests(props: ChatPullRequestsProps): boolean {
  return (
    props.pullRequests.length > 0 ||
    (props.publishedOnly ? props.publication?.result?.status === "published" : showWorkRow(props))
  );
}

function readDismissedStore(storage: Storage): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(DISMISSED_STORAGE_KEY) ?? "{}");
    if (!isRecord(parsed)) {
      return {};
    }
    const store: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        store[key] = value.filter((id): id is string => typeof id === "string");
      }
    }
    return store;
  } catch {
    return {};
  }
}

export function listDismissedChatPullRequests(
  storage: Storage | null,
  sessionKey: string,
): ReadonlySet<string> {
  if (!storage || !sessionKey) {
    return new Set();
  }
  return new Set(readDismissedStore(storage)[sessionKey] ?? []);
}

/** Records a PR (`chatPullRequestId`) or branch (`chatBranchId`) dismissal. */
export function dismissChatPullRequest(
  storage: Storage | null,
  sessionKey: string,
  id: string,
): ReadonlySet<string> {
  if (!storage || !sessionKey) {
    return new Set([id]);
  }
  const store = readDismissedStore(storage);
  const ids = new Set(store[sessionKey] ?? []);
  ids.add(id);
  delete store[sessionKey];
  store[sessionKey] = [...ids];
  const staleSessions = Object.keys(store).slice(0, -DISMISSED_SESSION_LIMIT);
  for (const staleKey of staleSessions) {
    delete store[staleKey];
  }
  try {
    storage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Quota or privacy-mode failures only cost re-showing dismissed chips.
  }
  return ids;
}
