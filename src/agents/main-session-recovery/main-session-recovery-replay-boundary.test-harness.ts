import path from "node:path";
import { expect, it } from "vitest";
import { callGateway } from "../../gateway/call.js";
import {
  createAssistantToolCallMessage,
  type SessionEntryFixture,
} from "../subagent-test-fixtures.test-helpers.js";
import { readStore } from "./main-session-restart-recovery-fixture.test-support.js";
import {
  codeModeCheckpointMessage,
  makeToolResultMessage,
  makeUserMessage,
  toolCall,
} from "./main-session-restart-recovery-transcript.test-support.js";

type ReplayBoundaryRecoveryFixture = {
  writePreparedMainSessionTranscript: (
    messages: readonly unknown[],
    entry?: SessionEntryFixture,
  ) => Promise<string>;
  expectRecovery: (expected: {
    started: number;
    settled: number;
    failed: number;
    skipped: number;
  }) => Promise<void>;
  gatewayParams: () => Record<string, unknown>;
};

export function registerReplayBoundaryRecoveryCases(harness: ReplayBoundaryRecoveryFixture): void {
  const { writePreparedMainSessionTranscript, expectRecovery, gatewayParams } = harness;
  it("resumes stale approval-pending exec tool results with restart-safe tools", async () => {
    const sessionsDir = await writePreparedMainSessionTranscript([
      makeUserMessage("run a command that needs approval"),
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      makeToolResultMessage("Approval required (id stale, full stale-approval-id).", {
        details: {
          status: "approval-pending",
          approvalId: "stale-approval-id",
          host: "gateway",
          command: "echo stale",
        },
      }),
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBeUndefined();
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("keeps restart safety across a second restart of the recovery turn", async () => {
    await writePreparedMainSessionTranscript(
      [
        { role: "user", content: "do the thing" },
        {
          role: "user",
          content:
            "[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work. Continue from the existing transcript and finish the interrupted response.",
        },
        createAssistantToolCallMessage([toolCall("call-read-1", "read", { path: "README.md" })]),
        {
          role: "toolResult",
          toolName: "read",
          content: [{ type: "text", text: "read result" }],
        },
      ],
      { restartRecoveryForceSafeTools: true },
    );

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it.each(["guarded", "full"] as const)(
    "keeps replay safety outside the recent transcript window with %s access",
    async (permissionMode) => {
      await writePreparedMainSessionTranscript(
        [
          { role: "user", content: "do the thing" },
          codeModeCheckpointMessage(),
          {
            role: "user",
            content: "Continue after restart",
            provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
          },
          ...Array.from({ length: 24 }, (_, index) => ({
            role: "toolResult",
            toolName: "read",
            content: [{ type: "text", text: `read result ${index}` }],
          })),
        ],
        { permissionMode, restartRecoveryForceSafeTools: true },
      );

      await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
      expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    },
  );

  it("resumes an in-flight safe tool call across a repeated restart", async () => {
    await writePreparedMainSessionTranscript(
      [
        { role: "user", content: "do the thing" },
        createAssistantToolCallMessage([
          { type: "thinking", thinking: "I need one more read." },
          { type: "toolCall", id: "call-read-2", name: "read", arguments: { path: "README.md" } },
        ]),
      ],
      { restartRecoveryForceSafeTools: true },
    );

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it.each(["guarded", "full"] as const)(
    "retains explicit replay safety after a provider error with %s access",
    async (permissionMode) => {
      await writePreparedMainSessionTranscript(
        [
          { role: "user", content: "do the thing" },
          codeModeCheckpointMessage(),
          {
            role: "assistant",
            stopReason: "error",
            content: [{ type: "text", text: "Provider failed." }],
          },
        ],
        { permissionMode, restartRecoveryForceSafeTools: true },
      );

      await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
      expect(callGateway).toHaveBeenCalledOnce();
      expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    },
  );

  it("ends prior replay restrictions at a new full-access user turn", async () => {
    await writePreparedMainSessionTranscript(
      [
        { role: "user", content: "the earlier request" },
        codeModeCheckpointMessage(),
        {
          role: "user",
          provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
          content:
            "[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work. Continue from the existing transcript and finish the interrupted response.",
        },
        { role: "assistant", content: [{ type: "text", text: "Finished that recovery." }] },
        { role: "user", content: "a later request" },
        { role: "assistant", content: [{ type: "text", text: "Finished the later request." }] },
      ],
      { permissionMode: "full", restartRecoveryForceSafeTools: true },
    );

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams()).not.toHaveProperty("forceRestartSafeTools");
  });
}
