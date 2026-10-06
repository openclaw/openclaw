import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";

// Source-generated output of fail_recovery at v2026.7.2-beta.3
// (d111bef0eed5aefb1e7c5ac59801c1f0924495f1), with distinct channel/runtime IDs.
// The historical owner cleared the aggregate and route but retained the runtime
// fence. Keep its output in the startup regression, not a modern interrupted row.
export function legacyFailedRecoveryEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "legacy-session",
    updatedAt: 200,
    startedAt: 100,
    status: "failed",
    abortedLastRun: true,
    restartRecoveryRuns: [
      {
        runId: "legacy-runtime",
        lifecycleGeneration: "old-generation",
      },
    ],
    endedAt: 200,
    restartRecoveryTerminalRunIds: ["legacy-channel-source"],
    ...overrides,
  };
}
