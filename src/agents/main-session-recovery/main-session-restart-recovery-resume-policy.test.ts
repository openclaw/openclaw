import { describe, expect, it, vi } from "vitest";
import { createNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import { resolveMainSessionResumePolicy } from "./main-session-restart-recovery-resume-policy.js";

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

function progressMessage(text: string, itemId: string): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    openclawStreamFallback: {
      replacementText: text,
      source: "segment",
      itemId,
    },
  };
}

function asyncDeliveryMessage(text: string, itemId: string): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    phase: "final_answer",
    openclawAsyncDelivery: { itemId },
  };
}

function resolvePolicy(params: {
  messages?: unknown[];
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
    params.messages ?? [{ role: "user", content: "finish the interrupted work" }],
    false,
    "source-turn",
    params.beforeAgentReplyState,
    params.deliveryReceiptState,
    params.deliveryToolCallId,
  );
}

function codeModeCheckpoint(params: {
  replaySafe: boolean;
  runId?: string;
  status?: "completed" | "failed" | "waiting";
}) {
  return {
    role: "toolResult",
    toolName: "exec",
    toolCallId: "exec-call",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: params.status ?? "waiting",
          replaySafe: params.replaySafe,
          ...(params.runId ? { runId: params.runId } : {}),
        }),
      },
    ],
  };
}

function codeModeWait(runId = "code-run") {
  return {
    role: "assistant",
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "wait-call", name: "wait", arguments: { runId } }],
  };
}

function nestedToolActivity(toolName: string, parentToolCallId = "exec-call") {
  return createNestedToolActivity({
    runId: "code-run",
    scopeId: "code-scope",
    afterEntryId: null,
    startOrder: 0,
    parentToolCallId,
    toolCallId: `${toolName}-call`,
    toolName,
    input: {},
    result: { content: [{ type: "text", text: "done" }] },
    isError: false,
    startedAt: 1,
    timestamp: 2,
  });
}

function missingToolResult(toolName: string) {
  return {
    role: "toolResult",
    toolName,
    details: { reason: "missing_tool_result" },
    content: [{ type: "text", text: "outcome unknown" }],
  };
}

describe("resolveMainSessionResumePolicy former terminal states", () => {
  it.each([
    {
      label: "terminal delivery whose outcome is unknown",
      params: { deliveryReceiptState: "terminal-pending" as const },
      expected: { action: "resume", forceRestartSafeTools: true },
    },
    {
      label: "delivered receipt without tool-call correlation",
      params: { deliveryReceiptState: "delivered-terminal" as const },
      expected: {
        action: "resume",
        forceRestartSafeTools: true,
      },
    },
    ...(["pending", "handled-reply", "handled-unrecoverable"] as const).map((state) => ({
      label: `before_agent_reply ${state}`,
      params: { beforeAgentReplyState: state },
      expected: { action: "resume" as const, forceRestartSafeTools: true },
    })),
    {
      label: "empty transcript",
      params: { messages: [] },
      expected: { action: "resume", forceRestartSafeTools: false },
    },
    {
      label: "completed assistant tail",
      params: {
        messages: [
          { role: "user", content: "finish the interrupted work" },
          { role: "assistant", content: [{ type: "text", text: "Already finished." }] },
        ],
      },
      expected: { action: "resume", forceRestartSafeTools: false },
    },
    {
      label: "stale approval-pending result",
      params: {
        messages: [
          { role: "user", content: "run the command" },
          {
            role: "toolResult",
            toolName: "exec",
            details: { status: "approval-pending" },
            content: [{ type: "text", text: "Approval required." }],
          },
        ],
      },
      expected: {
        action: "resume",
        forceRestartSafeTools: true,
      },
    },
    {
      label: "non-replay-safe Code Mode checkpoint",
      params: {
        messages: [
          { role: "user", content: "continue the code run" },
          codeModeCheckpoint({ replaySafe: false, runId: "code-run" }),
        ],
      },
      expected: {
        action: "tombstone",
        reason: "interrupted turn included mutating tool work",
      },
    },
    {
      label: "Code Mode wait with an unmatched checkpoint",
      params: {
        messages: [
          { role: "user", content: "continue the code run" },
          codeModeCheckpoint({ replaySafe: true, runId: "other-run" }),
          codeModeWait(),
        ],
      },
      expected: {
        action: "tombstone",
        reason: "interrupted turn included mutating tool work",
      },
    },
    {
      label: "mixed Code Mode wait and side-effecting call",
      params: {
        messages: [
          { role: "user", content: "continue the code run" },
          codeModeCheckpoint({ replaySafe: true, runId: "code-run" }),
          {
            role: "assistant",
            stopReason: "toolUse",
            content: [
              { type: "toolCall", id: "wait-call", name: "wait", arguments: { runId: "code-run" } },
              { type: "toolCall", id: "write-call", name: "write", arguments: {} },
            ],
          },
        ],
      },
      expected: {
        action: "tombstone",
        reason: "interrupted turn included mutating tool work",
      },
    },
  ])("maps $label to $expected", ({ params, expected }) => {
    expect(resolvePolicy(params)).toEqual(expected);
  });

  it("keeps replay-safe Code Mode reconstruction enabled only for a matching checkpoint", () => {
    expect(
      resolvePolicy({
        messages: [
          { role: "user", content: "continue the code run" },
          codeModeCheckpoint({ replaySafe: true, runId: "code-run" }),
          codeModeWait(),
        ],
      }),
    ).toEqual({
      action: "resume",
      forceRestartSafeTools: true,
      forceCodeModeTools: true,
    });
  });

  it("trusts nested Code Mode work only behind a replay-safe checkpoint", () => {
    const nested = nestedToolActivity("plugin_lookup");
    expect(
      resolvePolicy({
        messages: [
          { role: "user", content: "continue the code run" },
          codeModeCheckpoint({ replaySafe: true, runId: "code-run" }),
          nested,
          codeModeWait(),
        ],
      }),
    ).toEqual({
      action: "tombstone",
      reason: "interrupted turn included mutating tool work",
    });
    expect(
      resolvePolicy({
        messages: [
          { role: "user", content: "continue the code run" },
          codeModeCheckpoint({ replaySafe: false, runId: "code-run" }),
          nested,
          codeModeWait(),
        ],
      }),
    ).toEqual({
      action: "tombstone",
      reason: "interrupted turn included mutating tool work",
    });
  });

  it("does not let an earlier Code Mode checkpoint cover later nested work", () => {
    expect(
      resolvePolicy({
        messages: [
          { role: "user", content: "continue the code run" },
          codeModeCheckpoint({ replaySafe: true, runId: "code-run" }),
          nestedToolActivity("write", "later-exec-call"),
        ],
      }),
    ).toEqual({
      action: "tombstone",
      reason: "interrupted turn included mutating tool work",
    });
  });

  it("does not let a checkpoint cover later nested work from the same call", () => {
    expect(
      resolvePolicy({
        messages: [
          { role: "user", content: "continue the code run" },
          codeModeCheckpoint({ replaySafe: true, runId: "code-run" }),
          nestedToolActivity("write"),
        ],
      }),
    ).toEqual({
      action: "tombstone",
      reason: "interrupted turn included mutating tool work",
    });
  });

  it("requires a checkpoint even when nested Code Mode work is read-only", () => {
    expect(
      resolvePolicy({
        messages: [
          { role: "user", content: "continue the code run" },
          nestedToolActivity("read", "uncheckpointed-exec"),
        ],
      }),
    ).toEqual({
      action: "tombstone",
      reason: "interrupted turn included mutating tool work",
    });
  });

  it("distinguishes approval-pending from an unknown mutating outcome", () => {
    const execCall = {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "exec-call", name: "exec", arguments: { command: "touch x" } },
      ],
    };
    expect(
      resolvePolicy({
        messages: [
          { role: "user", content: "run it" },
          execCall,
          {
            ...missingToolResult("exec"),
            toolCallId: "exec-call",
            details: { status: "approval-pending" },
          },
        ],
      }),
    ).toEqual({ action: "resume", forceRestartSafeTools: true });
    expect(
      resolvePolicy({
        messages: [{ role: "user", content: "run it" }, execCall, missingToolResult("exec")],
      }),
    ).toEqual({
      action: "tombstone",
      reason: "interrupted turn included mutating tool work",
    });
  });

  it("does not let a later approval hide an earlier mutation", () => {
    expect(
      resolvePolicy({
        messages: [
          { role: "user", content: "update both settings" },
          {
            role: "assistant",
            stopReason: "toolUse",
            content: [
              { type: "toolCall", id: "write-call", name: "write", arguments: { path: "x" } },
            ],
          },
          { role: "toolResult", toolName: "write", toolCallId: "write-call", content: "done" },
          {
            role: "assistant",
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "exec-call",
                name: "exec",
                arguments: { command: "touch y" },
              },
            ],
          },
          {
            ...missingToolResult("exec"),
            toolCallId: "exec-call",
            details: { status: "approval-pending" },
          },
        ],
      }),
    ).toEqual({
      action: "tombstone",
      reason: "interrupted turn included mutating tool work",
    });
  });

  it("does not apply a replay-safe checkpoint to another Code Mode call", () => {
    expect(
      resolvePolicy({
        messages: [
          { role: "user", content: "continue both code runs" },
          nestedToolActivity("write"),
          codeModeCheckpoint({ replaySafe: false, runId: "code-run-b" }),
          {
            ...codeModeCheckpoint({ replaySafe: true, runId: "code-run-a" }),
            toolCallId: "other-exec-call",
          },
        ],
      }),
    ).toEqual({
      action: "tombstone",
      reason: "interrupted turn included mutating tool work",
    });
  });

  it("rejects a non-tail unproven Code Mode call before hook resume", () => {
    expect(
      resolvePolicy({
        beforeAgentReplyState: "handled-reply",
        messages: [
          { role: "user", content: "continue the code run" },
          codeModeCheckpoint({ replaySafe: false, runId: "code-run" }),
          { role: "assistant", content: [{ type: "text", text: "partial" }] },
        ],
      }),
    ).toEqual({
      action: "tombstone",
      reason: "interrupted turn included mutating tool work",
    });
  });
});

describe("resolveMainSessionResumePolicy progress tails", () => {
  it("resumes explicit commentary without making completed answers resumable", () => {
    expect(
      resolveMainSessionResumePolicy([
        { role: "user", content: "finish the interrupted work" },
        {
          role: "assistant",
          phase: "commentary",
          content: [{ type: "text", text: "Checking the workspace." }],
          stopReason: "stop",
        },
      ]),
    ).toEqual({ action: "resume", forceRestartSafeTools: false });

    expect(
      resolveMainSessionResumePolicy([
        { role: "user", content: "finish the interrupted work" },
        { role: "assistant", content: [{ type: "text", text: "The work is complete." }] },
        progressMessage("A later progress item.", "progress-late"),
      ]),
    ).toEqual({ action: "resume", forceRestartSafeTools: false });
  });

  it("recognizes the existing provider text-signature commentary contract", () => {
    expect(
      resolveMainSessionResumePolicy([
        { role: "user", content: "finish the interrupted work" },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Checking the workspace.",
              textSignature: JSON.stringify({ v: 1, id: "progress-signed", phase: "commentary" }),
            },
          ],
          stopReason: "stop",
        },
      ]),
    ).toEqual({ action: "resume", forceRestartSafeTools: false });
  });

  it("keeps restart abort artifacts effective when progress arrives on either side", () => {
    expect(
      resolveMainSessionResumePolicy([
        { role: "user", content: "finish the interrupted work" },
        progressMessage("One last update before cancellation.", "progress-before-abort"),
        {
          role: "assistant",
          content: [],
          stopReason: "aborted",
          errorMessage: "agent run aborted for restart",
        },
        progressMessage("One delayed update after cancellation.", "progress-after-abort"),
      ]),
    ).toEqual({ action: "resume", forceRestartSafeTools: false });
  });

  it("keeps durable async delivery visible without treating it as the terminal answer", () => {
    expect(
      resolveMainSessionResumePolicy([
        { role: "user", content: "finish the interrupted work" },
        asyncDeliveryMessage("A background agent completed.", "async-agent-1"),
      ]),
    ).toEqual({ action: "resume", forceRestartSafeTools: false });
  });

  it("terminalizes a side-effecting call even when async delivery follows it", () => {
    expect(
      resolveMainSessionResumePolicy([
        { role: "user", content: "finish the interrupted work" },
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            { type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "true" } },
          ],
        },
        asyncDeliveryMessage("The background check finished.", "async-after-exec"),
      ]),
    ).toEqual({
      action: "tombstone",
      reason: "interrupted turn included mutating tool work",
    });
  });

  it("never treats unkeyed stream fallbacks as authoritative progress", () => {
    expect(
      resolveMainSessionResumePolicy([
        { role: "user", content: "finish the interrupted work" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Possibly final output." }],
          stopReason: "stop",
          openclawStreamFallback: { replacementText: "Possibly final output.", source: "current" },
        },
      ]),
    ).toEqual({ action: "resume", forceRestartSafeTools: false });
  });

  it("keeps explicit final-answer phase authoritative over keyed fallback metadata", () => {
    expect(
      resolveMainSessionResumePolicy([
        { role: "user", content: "finish the interrupted work" },
        {
          ...progressMessage("The work is complete.", "final-item"),
          phase: "final_answer",
        },
      ]),
    ).toEqual({ action: "resume", forceRestartSafeTools: false });

    expect(
      resolveMainSessionResumePolicy([
        { role: "user", content: "finish the interrupted work" },
        {
          role: "assistant",
          content: [{ type: "text", text: "The work is complete." }],
          stopReason: "stop",
          phase: "final_answer",
          openclawAsyncDelivery: { itemId: " " },
        },
      ]),
    ).toEqual({ action: "resume", forceRestartSafeTools: false });
  });
});
