export type NotificationTier = "silent" | "quiet" | "loud";

export type NotificationEvent = {
  id: string;
  tier: NotificationTier;
  title: string;
  body?: string;
  actions?: Array<{ label: string; callbackData: string }>;
  source: string;
  timestamp: number;
};

export function classifyNotificationTier(
  eventType: string,
  context?: { isError?: boolean; needsHumanInput?: boolean; isUrgent?: boolean },
): NotificationTier {
  if (context?.needsHumanInput || context?.isUrgent) return "loud";
  if (context?.isError) return "loud";

  switch (eventType) {
    case "task_progress":
    case "heartbeat":
    case "token_usage":
      return "silent";

    case "task_complete":
    case "ci_success":
    case "pr_merged":
    case "cron_complete":
      return "quiet";

    case "task_error":
    case "ci_failure":
    case "approval_needed":
    case "deploy_failed":
    case "rate_limit":
    case "agent_crash":
      return "loud";

    default:
      return "quiet";
  }
}

export function formatNotificationMessage(event: NotificationEvent): {
  text: string;
  silent: boolean;
  buttons?: Array<{ label: string; value: string }>;
} {
  const tierEmoji =
    event.tier === "loud" ? "🔔" : event.tier === "quiet" ? "📌" : "";

  const lines = [`${tierEmoji} <b>${event.title}</b>`];
  if (event.body) {
    lines.push("", event.body);
  }

  return {
    text: lines.join("\n"),
    silent: event.tier === "silent",
    buttons: event.actions?.map((a) => ({
      label: a.label,
      value: a.callbackData,
    })),
  };
}

export function shouldUpdateDashboard(tier: NotificationTier): boolean {
  return true;
}

export function shouldSendNewMessage(tier: NotificationTier): boolean {
  return tier === "quiet" || tier === "loud";
}

export function shouldNotifyWithSound(tier: NotificationTier): boolean {
  return tier === "loud";
}
