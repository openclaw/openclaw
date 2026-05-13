import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  buildChildCompletionFindings,
  readSubagentOutput,
  UNSAFE_SUBAGENT_OUTPUT_FALLBACK,
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

  it("uses a safe fallback for tool-use assistant output without a final answer", async () => {
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
      UNSAFE_SUBAGENT_OUTPUT_FALLBACK,
    );
  });

  it("does not auto-announce raw tool result output when no final answer exists", async () => {
    installOutputDeps({
      messages: [
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "call-read", name: "read", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "call-read",
          toolName: "read",
          content: [{ type: "text", text: "import { x } from './x';\nexport const y = 1;" }],
        },
      ],
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBe(
      UNSAFE_SUBAGENT_OUTPUT_FALLBACK,
    );
  });

  it("does not auto-announce raw unfenced source dumps verbatim", async () => {
    installOutputDeps({
      messages: [
        {
          role: "assistant",
          stopReason: "stop",
          content: [
            {
              type: "text",
              text: [
                "import { readFile } from 'node:fs/promises';",
                "export type Result = { ok: boolean };",
                "const value = await readFile('/tmp/a.ts', 'utf8');",
                "function parse() {",
                "  return value.trim();",
                "}",
              ].join("\n"),
            },
          ],
        },
      ],
    });

    const result = await readSubagentOutput("agent:main:subagent:child");
    expect(result).toBe(UNSAFE_SUBAGENT_OUTPUT_FALLBACK);
    expect(result).not.toContain("readFile");
  });

  it("allows clean final summaries", async () => {
    installOutputDeps({
      messages: [
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Fixed the announce path and added regression tests." }],
        },
      ],
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBe(
      "Fixed the announce path and added regression tests.",
    );
  });

  it("preserves explicit final user-facing fenced code snippets", async () => {
    const finalText = [
      "Use this helper in the final docs:",
      "",
      "```ts",
      "export function ok() {",
      "  return true;",
      "}",
      "```",
    ].join("\n");
    installOutputDeps({
      messages: [
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: finalText }],
        },
      ],
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBe(finalText);
  });

  it("keeps NO_REPLY silent", async () => {
    installOutputDeps({
      messages: [
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "NO_REPLY" }],
        },
      ],
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBe("NO_REPLY");
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

  it("sanitizes unsafe child completion findings before descendant wake", () => {
    const findings = buildChildCompletionFindings([
      {
        childSessionKey: "agent:main:subagent:raw-source",
        task: "raw source task",
        createdAt: 1,
        frozenResultText: [
          "src/agents/a.ts:1:import { x } from './x';",
          "src/agents/a.ts:2:export const a = 1;",
          "src/agents/b.ts:1:import { y } from './y';",
        ].join("\n"),
        outcome: { status: "ok" },
      },
    ]);

    expect(findings).toContain(UNSAFE_SUBAGENT_OUTPUT_FALLBACK);
    expect(findings).not.toContain("src/agents/a.ts:1:import");
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
