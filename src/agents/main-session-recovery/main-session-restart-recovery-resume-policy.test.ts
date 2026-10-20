import { describe, expect, it, vi } from "vitest";
import { resolveMainSessionResumePolicy } from "./main-session-restart-recovery-resume-policy.js";
import {
  textContent,
  makeUserMessage,
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

function asyncDeliveryMessage(text: string, itemId: string): Record<string, unknown> {
  return {
    role: "assistant",
    content: textContent(text),
    stopReason: "stop",
    phase: "final_answer",
    openclawAsyncDelivery: { itemId },
  };
}

function resolvePolicy(params: {
  messages?: unknown[];
  fullAccess?: boolean;
  beforeAgentReplyState?:
    | "admitted"
    | "pending"
    | "continue"
    | "handled-silent"
    | "handled-reply"
    | "handled-unrecoverable";
  deliveryReceiptState?: "terminal-pending" | "delivered-terminal";
  deliveryToolCallId?: string;
}) {
  return resolveMainSessionResumePolicy(
    params.messages ?? [makeUserMessage("finish the interrupted work")],
    false,
    "source-turn",
    params.beforeAgentReplyState,
    params.deliveryReceiptState,
    params.deliveryToolCallId,
    params.fullAccess,
  );
}

describe("resolveMainSessionResumePolicy former terminal states", () => {
  it.each([
    { deliveryReceiptState: "terminal-pending" as const },
    { beforeAgentReplyState: "pending" as const },
    { beforeAgentReplyState: "handled-reply" as const },
    { beforeAgentReplyState: "handled-unrecoverable" as const },
    {
      messages: [
        codeModeCheckpointMessage("exec", {
          status: "waiting",
          replaySafe: true,
          runId: "code-run",
        }),
        codeModeWaitCallMessage("code-run", "wait-call"),
      ],
    },
  ])("retains reconciliation restrictions under full access: %j", (params) => {
    expect(resolvePolicy({ ...params, fullAccess: true })).toMatchObject({
      action: "resume",
      forceRestartSafeTools: true,
    });
  });
  it("keeps an uncorrelated delivered receipt restricted", () => {
    expect(resolvePolicy({ deliveryReceiptState: "delivered-terminal" })).toEqual({
      action: "resume",
      forceRestartSafeTools: true,
    });
  });
});

describe("resolveMainSessionResumePolicy progress tails", () => {
  it("retains replay restrictions when final-phase async delivery follows a side-effecting call", () => {
    expect(
      resolveMainSessionResumePolicy([
        makeUserMessage("finish the interrupted work"),
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [toolCall("call-bash", "bash", { command: "true" })],
        },
        asyncDeliveryMessage("The background check finished.", "async-after-exec"),
      ]),
    ).toEqual({ action: "resume", forceRestartSafeTools: true });
  });
});
