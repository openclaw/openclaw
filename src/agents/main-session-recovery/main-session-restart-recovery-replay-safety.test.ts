import { describe, expect, it, vi } from "vitest";

const transcript = vi.hoisted(() => ({ messages: [] as Array<Record<string, unknown>> }));

vi.mock("../../gateway/session-transcript-readers.js", () => ({
  visitSessionMessagesAsync: vi.fn(
    async (_scope: unknown, visit: (message: Record<string, unknown>) => void) => {
      transcript.messages.forEach(visit);
    },
  ),
}));

import {
  readMainSessionRecoveryCheckpoint,
  shouldRetainRestartSafeTools,
} from "./main-session-restart-recovery-replay-safety.js";

const scope = { sessionId: "session-1", sessionKey: "agent:main:main" };
const recoveryInput = {
  role: "user",
  provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
};
const replaySafeCheckpoint = {
  role: "toolResult",
  toolName: "exec",
  content: [{ type: "text", text: '{"status":"waiting","runId":"run-1","replaySafe":true}' }],
};

describe("restart recovery replay safety", () => {
  it.each([
    ["tool timeout with full access retains safe tools", true, true, false, true],
    ["restart with full access releases safe tools", true, false, false, false],
    ["restart with guarded access retains safe tools", false, false, false, true],
    ["restart followed by a human turn releases safe tools", false, false, true, false],
  ] as const)("%s", (_label, fullAccess, safeToolsRequired, humanTurnAfterRecovery, expected) => {
    expect(
      shouldRetainRestartSafeTools({
        entry: {
          restartRecoveryForceSafeTools: true,
          mainRestartRecovery: safeToolsRequired
            ? { cycleId: "cycle", revision: 1, chargedAttempts: 0, safeToolsRequired: true }
            : undefined,
        },
        fullAccess,
        humanTurnAfterRecovery,
        replaySafeCheckpoint: false,
      }),
    ).toBe(expected);
  });

  it.each([
    ["internal system input", { kind: "internal_system", sourceTool: "runtime_update" }],
    ["inter-session completion", { kind: "inter_session", sourceTool: "subagent_settle" }],
  ])("does not treat %s as a later human turn", async (_label, provenance) => {
    transcript.messages = [recoveryInput, replaySafeCheckpoint, { role: "user", provenance }];

    await expect(readMainSessionRecoveryCheckpoint(scope)).resolves.toMatchObject({
      humanTurnAfterRecovery: false,
      replaySafe: true,
    });
  });

  it("expires the restriction after a genuine external user turn", async () => {
    transcript.messages = [
      recoveryInput,
      replaySafeCheckpoint,
      { role: "user", provenance: { kind: "external_user" } },
    ];

    await expect(readMainSessionRecoveryCheckpoint(scope)).resolves.toMatchObject({
      humanTurnAfterRecovery: true,
      replaySafe: false,
    });
  });
});
