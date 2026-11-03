import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "@openclaw/gateway-protocol";
import type { ControlUiPresentationHost } from "openclaw/plugin-sdk/control-ui";
import type { GitHubPublicationView } from "./github-publication-owner.ts";
import { publicationPullRequestTarget } from "./pull-request-dismissal.ts";
type Translate = ControlUiPresentationHost["translate"];
type PillView = Parameters<ControlUiPresentationHost["mountActivityPill"]>[1]["view"];
type Badge = NonNullable<PillView["badge"]>;
const prIcons = {
  open: "gitPullRequest",
  draft: "gitPullRequestDraft",
  merged: "gitMerge",
  closed: "gitPullRequestClosed",
} as const;
const prTones = { open: "ok", draft: "muted", merged: "purple", closed: "danger" } as const;

export function pullRequestView(
  pr: ControlUiSessionPullRequest,
  status: ControlUiSessionPullRequestSnapshot["status"],
  t: Translate,
): PillView {
  const checks =
    (pr.state === "open" || pr.state === "draft") && status === "ready" ? pr.checks : undefined;
  const badge: Badge | undefined = checks
    ? {
        icon: checks.state === "pending" ? "spinner" : checks.state === "passing" ? "check" : "x",
        tone: checks.state === "passing" ? "ok" : checks.state === "failing" ? "danger" : "normal",
        label:
          checks.state === "passing"
            ? t("chat.activityPills.pullRequest.checksPassed")
            : checks.state === "failing"
              ? t("chat.activityPills.pullRequest.checksFailed")
              : t("chat.activityPills.pullRequest.checksRunning"),
      }
    : undefined;
  const query =
    status === "ready"
      ? ""
      : status === "rate-limited"
        ? t("chat.activityPills.pullRequest.rateLimitedSuffix")
        : t("chat.activityPills.pullRequest.unavailableSuffix");
  return {
    label: t("chat.activityPills.pullRequest.number", { number: String(pr.number) }),
    icon: prIcons[pr.state],
    tone: prTones[pr.state],
    badge,
    attention: status === "unavailable",
    description: t("chat.activityPills.pullRequest.description", {
      owner: pr.owner,
      repo: pr.repo,
      number: String(pr.number),
      title: pr.title,
      state: t(`chat.activityPills.pullRequest.states.${pr.state}`),
      checks: badge
        ? t("chat.activityPills.pullRequest.checksSuffix", { checks: badge.label })
        : "",
      query,
    }),
  };
}

export function publicationView(view: GitHubPublicationView, t: Translate): PillView {
  if (view.activity !== null) {
    return {
      label:
        view.activity === "read"
          ? view.result || view.locked
            ? t("chat.activityPills.publication.verifying")
            : t("chat.activityPills.publication.checkingOptions")
          : t("chat.activityPills.publication.publishing"),
      icon: "gitPullRequest",
      badge: { icon: "spinner", tone: "normal", label: t("chat.activityPills.pending") },
    };
  }
  if (view.optionsUnavailable) {
    return {
      label: t("chat.activityPills.publication.unavailable"),
      icon: "gitPullRequest",
      badge: {
        icon: "alertTriangle",
        tone: "warn",
        label: t("chat.activityPills.publication.discoveryUnavailable"),
      },
      attention: true,
    };
  }
  // A failed verification must stay visible over the retained request/result.
  if (view.error || (view.locked && !view.result)) {
    return {
      label: t("chat.activityPills.publication.unconfirmed"),
      icon: "gitPullRequest",
      badge: {
        icon: "alertTriangle",
        tone: "warn",
        label: t("chat.activityPills.publication.verifyBeforeRetry"),
      },
      attention: true,
    };
  }
  if (view.result?.status === "published") {
    const target = publicationPullRequestTarget(view);
    return {
      label: target
        ? t("chat.activityPills.pullRequest.number", { number: String(target.number) })
        : t("chat.activityPills.publication.published"),
      icon: "gitPullRequest",
      badge: {
        icon: "check",
        tone: "ok",
        label: t("chat.activityPills.publication.publishedBadge"),
      },
    };
  }
  if (view.result?.status === "failed") {
    return {
      label: t("chat.activityPills.publication.failed"),
      icon: "gitPullRequest",
      tone: "danger",
      badge: { icon: "x", tone: "danger", label: t("githubPublication.statusFailed") },
      attention: true,
    };
  }
  if (view.result?.status === "needs_confirmation") {
    return {
      label: t("chat.activityPills.publication.confirm"),
      icon: "gitPullRequest",
      badge: { icon: "clock", tone: "warn", label: t("githubPublication.statusConfirm") },
    };
  }
  if (view.result?.status === "requested" || view.result?.status === "publishing") {
    return {
      label:
        view.result.status === "requested"
          ? t("githubPublication.statusRequested")
          : t("chat.activityPills.publication.publishing"),
      icon: "gitPullRequest",
      badge: {
        icon: view.result.status === "requested" ? "clock" : "spinner",
        tone: "warn",
        label: t(
          view.result.status === "requested"
            ? "chat.activityPills.publication.requestedBadge"
            : "chat.activityPills.publication.publishingBadge",
        ),
      },
    };
  }
  return {
    label: t("chat.pullRequests.publishPr"),
    icon: "github",
    description: t("chat.activityPills.publication.review"),
  };
}
