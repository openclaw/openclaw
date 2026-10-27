import { expect, it, vi } from "vitest";
import { resolveMainSessionResumePolicy } from "./main-session-restart-recovery-resume-policy.js";
import {
  makeUserMessage,
  makeAssistantTextMessage,
  toolCall,
  codeModeCheckpointMessage,
  codeModeWaitCallMessage,
} from "./main-session-restart-recovery-transcript.test-support.js";

vi.mock("../code-mode-control-tools.js", () => ({
  CODE_MODE_EXEC_TOOL_NAME: "exec",
  CODE_MODE_WAIT_TOOL_NAME: "wait",
}));

vi.mock("../tool-replay-safety.js", () => ({
  isAgentToolReplaySafe: ({ name }: { name?: string }) => name === "read",
}));

vi.mock("../run-termination.js", () => ({
  AGENT_RUN_RESTART_ABORT_ERROR: "agent run aborted for restart",
  AGENT_RUN_RESTART_ABORT_ERROR_CODE: "OPENCLAW_RESTART_ABORT",
}));

type PolicyArgs = Parameters<typeof resolveMainSessionResumePolicy>;
const user = makeUserMessage("finish the interrupted work");

it.each<[PolicyArgs[3], PolicyArgs[4], unknown[]?]>([
  [undefined, "terminal-pending"],
  ["pending", undefined],
  ["handled-reply", undefined],
  ["handled-unrecoverable", undefined],
  [undefined, undefined, [codeModeCheckpointMessage("exec"), codeModeWaitCallMessage()]],
])(
  "retains reconciliation restrictions under full access: %j / %j / %j",
  (before, receipt, messages) => {
    expect(
      resolveMainSessionResumePolicy(
        messages ?? [user],
        false,
        "source-turn",
        before,
        receipt,
        undefined,
        true,
      ),
    ).toMatchObject({
      action: "resume",
      forceRestartSafeTools: true,
    });
  },
);
it("keeps an uncorrelated delivered receipt restricted", () => {
  expect(
    resolveMainSessionResumePolicy([user], false, "source-turn", undefined, "delivered-terminal"),
  ).toEqual({
    action: "resume",
    forceRestartSafeTools: true,
  });
});
it("retains replay restrictions when final-phase async delivery follows a side-effecting call", () => {
  expect(
    resolveMainSessionResumePolicy([
      user,
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [toolCall("call-bash", "bash", { command: "true" })],
      },
      makeAssistantTextMessage("The background check finished.", {
        stopReason: "stop",
        phase: "final_answer",
        openclawAsyncDelivery: { itemId: "async-after-exec" },
      }),
    ]),
  ).toEqual({ action: "resume", forceRestartSafeTools: true });
});
