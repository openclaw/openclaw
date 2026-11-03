import type { SessionCatalogPullRequestSummary } from "@openclaw/gateway-protocol";
import type {
  ControlUiSessionBadgeAccessory,
  ControlUiHostV2,
} from "openclaw/plugin-sdk/control-ui";
import { pullRequestEnglish } from "./pull-request-english.ts";
import type { RepositoryBrowserRuntime } from "./repository-runtime.ts";
import { summarizeSessionPullRequests } from "./session-pull-requests.ts";
import { projectSidebarBadge } from "./sidebar-badge-presentation.ts";

export function createSidebarBadgeAccessory(
  host: ControlUiHostV2,
  runtime: RepositoryBrowserRuntime,
): ControlUiSessionBadgeAccessory {
  const presentation = host.presentation;
  if (!presentation) {
    throw new Error("Repository presentation services are unavailable.");
  }
  presentation.registerEnglish(pullRequestEnglish);
  return {
    id: "pull-request",
    placement: "session-row",
    presentation: "badge",
    resolve(target) {
      const key = host.sessions.artifactKey(target);
      const readable = host.requests.canCall(
        "controlUi.sessionPullRequests.subscribe",
        "operator.read",
        true,
      );
      const initialSummary =
        (!target.worktreeId || (readable && host.requests.hasScope("operator.read"))) &&
        isSummary(target.artifact)
          ? target.artifact
          : undefined;
      const snapshot = runtime.store.get(key);
      const requests = [
        ...(snapshot?.pullRequests ?? []),
        ...(snapshot?.taskPullRequests ?? []).flatMap((task) =>
          task.pullRequest ? [task.pullRequest] : [],
        ),
      ];
      if (!snapshot && !initialSummary) {
        return readable ? { status: "pending" } : { status: "ready" };
      }
      const branchKnown = runtime.store.branchKnown(key);
      const summary =
        summarizeSessionPullRequests(requests) ?? (!branchKnown ? initialSummary : undefined);
      const count =
        snapshot &&
        !branchKnown &&
        snapshot.pullRequests.length === 0 &&
        !snapshot.taskPullRequestCount
          ? undefined
          : (snapshot?.pullRequestCount ??
            (snapshot
              ? Math.max(
                  new Set(
                    [...snapshot.pullRequests, ...(snapshot.taskPullRequests ?? [])].map(
                      (request) => request.url,
                    ),
                  ).size,
                  snapshot.taskPullRequestCount ?? 0,
                )
              : undefined));
      const badge = projectSidebarBadge(summary, count, presentation.translate);
      return {
        status: "ready",
        badge: badge
          ? {
              ...badge,
              tone:
                badge.state === "open"
                  ? "positive"
                  : badge.state === "merged"
                    ? "violet"
                    : badge.state === "closed"
                      ? "negative"
                      : "muted",
            }
          : undefined,
      };
    },
    observe(target, changed) {
      const owner = {};
      const key = host.sessions.artifactKey(target);
      const notify = () => {
        if (!target.signal.aborted) {
          changed();
        }
      };
      const sync = () => {
        if (target.signal.aborted) {
          return;
        }
        runtime.store.watch(owner, host.connection.connected && key ? [key] : [], {
          passive: true,
        });
        notify();
      };
      const stopHost = host.subscribe(sync);
      const stopStore = runtime.store.subscribe(notify);
      const stopLocale = presentation.subscribe(notify);
      sync();
      return () => {
        stopHost();
        stopStore();
        stopLocale();
        runtime.store.unwatch(owner);
      };
    },
  };
}

function isSummary(value: unknown): value is SessionCatalogPullRequestSummary {
  return (
    typeof value === "object" &&
    value !== null &&
    "numbers" in value &&
    Array.isArray(value.numbers) &&
    value.numbers.every((number) => typeof number === "number") &&
    "state" in value &&
    ["open", "draft", "merged", "closed"].includes(String(value.state))
  );
}
