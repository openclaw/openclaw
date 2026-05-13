import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  buildChildCompletionFindings,
  readSubagentOutput,
} from "./subagent-announce-output.js";

type CallGateway = typeof import("../gateway/call.js").callGateway;
type ReadLatestAssistantReply = typeof import("./tools/agent-step.js").readLatestAssistantReply;

function installOutputDeps(params: { messages: Array<unknown>; latestAssistantReply?: string }) {
  const callGateway = vi.fn(async () => ({ messages: params.messages }));
  const readLatestAssistantReply = vi.fn(async () => params.latestAssistantReply);
  __testing.setDepsForTest({
    callGateway: callGateway as unknown as CallGateway,
    readLatestAssistantReply: readLatestAssistantReply as unknown as ReadLatestAssistantReply,
  });
  return { callGateway, readLatestAssistantReply };
}

function sessionsYieldTurn(message = "Waiting for subagent completion.") {
  return [
    {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "text", text: message },
        {
          type: "toolCall",
          id: "call-yield",
          name: "sessions_yield",
          arguments: { message },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-yield",
      toolName: "sessions_yield",
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: "yielded", message }, null, 2),
        },
      ],
      details: { status: "yielded", message },
    },
  ];
}

describe("readSubagentOutput", () => {
  afterEach(() => {
    __testing.setDepsForTest();
  });

  it("does not treat a sessions_yield wait turn as subagent completion output", async () => {
    const deps = installOutputDeps({
      messages: sessionsYieldTurn(),
      latestAssistantReply: "Waiting for subagent completion.",
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBeUndefined();
    expect(deps.readLatestAssistantReply).not.toHaveBeenCalled();
  });

  it("returns final assistant output that arrives after a sessions_yield wait turn", async () => {
    installOutputDeps({
      messages: [
        ...sessionsYieldTurn(),
        {
          role: "system",
          content: [{ type: "text", text: "Compaction" }],
          __openclaw: { kind: "compaction" },
        },
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Created /tmp/final-deck.pptx" }],
        },
      ],
      latestAssistantReply: "Waiting for subagent completion.",
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBe(
      "Created /tmp/final-deck.pptx",
    );
  });

  it("keeps normal tool-use assistant output when the tool is not sessions_yield", async () => {
    installOutputDeps({
      messages: [
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            { type: "text", text: "Mapped the code path." },
            { type: "toolCall", id: "call-read", name: "read", arguments: {} },
          ],
        },
      ],
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBe(
      "Mapped the code path.",
    );
  });

  it("does not surface tool/raw startup context when a subagent lost active execution context", async () => {
    const leakedContext = [
      "# USER.md - About Your Human",
      "## Session Startup",
      "<available_skills>",
      "Tools are grouped by namespace where each namespace has one or more tools defined.",
    ].join("\n");
    const deps = installOutputDeps({
      messages: [
        {
          role: "toolResult",
          content: [{ type: "text", text: leakedContext }],
        },
      ],
      latestAssistantReply: leakedContext,
    });

    await expect(
      readSubagentOutput("agent:main:subagent:child", {
        status: "error",
        error: "subagent run lost active execution context",
      }),
    ).resolves.toBeUndefined();
    expect(deps.readLatestAssistantReply).not.toHaveBeenCalled();
  });

  it("suppresses internal context delimiters for lost active execution context failures", async () => {
    installOutputDeps({
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "text",
              text: "<system>\nKnowledge cutoff: 2024-06\n</system>\n## Runtime\nRuntime: agent=dev-wong",
            },
          ],
        },
      ],
    });

    await expect(
      readSubagentOutput("agent:main:subagent:child", {
        status: "error",
        error: "subagent run lost active execution context",
      }),
    ).resolves.toBeUndefined();
  });

  it("preserves normal ok assistant final output", async () => {
    installOutputDeps({
      messages: [
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Final verdict: PASS" }],
        },
      ],
    });

    await expect(readSubagentOutput("agent:main:subagent:child", { status: "ok" })).resolves.toBe(
      "Final verdict: PASS",
    );
  });
});

describe("buildChildCompletionFindings", () => {
  it("does not convert ANNOUNCE_SKIP child completions into no-output findings", () => {
    const findings = buildChildCompletionFindings([
      {
        childSessionKey: "agent:main:subagent:silent",
        task: "silent task",
        createdAt: 1,
        frozenResultText: "ANNOUNCE_SKIP",
        outcome: { status: "ok" },
      },
    ]);

    expect(findings).toBeUndefined();
  });

  it("keeps failed ANNOUNCE_SKIP child completions visible", () => {
    const findings = buildChildCompletionFindings([
      {
        childSessionKey: "agent:main:subagent:silent",
        task: "silent task",
        createdAt: 1,
        frozenResultText: "ANNOUNCE_SKIP",
        outcome: { status: "error", error: "boom" },
      },
    ]);

    expect(findings).toContain("status: error: boom");
    expect(findings).toContain("ANNOUNCE_SKIP");
  });

  it("numbers findings contiguously after skipped silent completions", () => {
    const findings = buildChildCompletionFindings([
      {
        childSessionKey: "agent:main:subagent:silent",
        task: "silent task",
        createdAt: 1,
        frozenResultText: "ANNOUNCE_SKIP",
        outcome: { status: "ok" },
      },
      {
        childSessionKey: "agent:main:subagent:visible",
        task: "visible task",
        createdAt: 2,
        frozenResultText: "actual output",
        outcome: { status: "ok" },
      },
    ]);

    expect(findings).toContain("1. visible task");
    expect(findings).not.toContain("2. visible task");
  });
});
