import { vi } from "vitest";
import type { GroupHistoryEntry } from "./inbound-context.js";
import type { processMessage } from "./process-message.js";

export function createMonitorContext(info: () => void = () => {}) {
  return {
    verbose: false,
    connectionId: "conn-1",
    maxMediaBytes: 1024 * 1024,
    groupHistories: new Map<string, GroupHistoryEntry[]>(),
    groupMemberNames: new Map<string, Map<string, string>>(),
    backgroundTasks: new Set<Promise<unknown>>(),
    replyResolver: vi.fn<Parameters<typeof processMessage>[0]["replyResolver"]>(
      async () => undefined,
    ),
    replyLogger: { info, warn: () => {}, debug: () => {}, error: () => {} } as never,
  };
}

export function blockedAdmission() {
  const reasonCode = "dm_policy_not_allowlisted";
  return {
    ingress: { admission: "drop", decision: "block", reasonCode },
    senderAccess: { allowed: false, decision: "block", reasonCode },
    activationAccess: { allowed: false, shouldSkip: true, reasonCode },
  } as const;
}
