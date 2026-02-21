import type { CapturedNotification, TriageLevel, TriagedNotification } from "./types.js";

/**
 * Heuristic triage based on Android notification priority and category.
 * Zero LLM cost -- runs synchronously on every batch.
 */
export function triageNotificationHeuristic(n: CapturedNotification): TriageLevel {
  // Android priority: -2 (MIN) to 2 (MAX). 1 = HIGH, 2 = MAX.
  if (typeof n.priority === "number" && n.priority >= 1) return "critical";

  // Category-based classification.
  const cat = n.category;
  if (cat) {
    switch (cat) {
      case "call":
      case "alarm":
      case "msg":
      case "email":
      case "social":
        return "important";
      case "promo":
      case "recommendation":
        return "noise";
      case "status":
      case "transport":
      case "service":
      case "progress":
      case "sys":
      case "navigation":
        return "informational";
    }
  }

  // Ongoing notifications (e.g. music player, foreground services) are informational.
  if (n.isOngoing) return "informational";

  return "informational";
}

export function triageBatch(notifications: CapturedNotification[]): TriagedNotification[] {
  return notifications.map((n) => ({
    ...n,
    triageLevel: triageNotificationHeuristic(n),
  }));
}
