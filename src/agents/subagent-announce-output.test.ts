import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  testing,
  buildChildCompletionFindings,
  readSubagentOutput,
} from "./subagent-announce-output.js";

type CallGateway = typeof import("../gateway/call.js").callGateway;
type ReadLatestAssistantReply = typeof import("./tools/agent-step.js").readLatestAssistantReply;

function installOutputDeps(params: { messages: Array<unknown>; latestAssistantReply?: string }) {
  const callGateway = vi.fn(async () => ({ messages: params.messages }));
  const readLatestAssistantReply = vi.fn(async () => params.latestAssistantReply);
  testing.setDepsForTest({
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
    testing.setDepsForTest();
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

  it("renders NO_REPLY child findings as structured suppression metadata only", () => {
    const findings = buildChildCompletionFindings([
      {
        childSessionKey: "agent:main:subagent:silent",
        task: "silent task",
        createdAt: 1,
        frozenResultText: "NO_REPLY",
        outcome: { status: "error", error: "boom" },
      },
    ]);

    expect(findings).toContain("status: error: boom");
    expect(findings).toContain("Child result control metadata");
    expect(findings).toContain('"reason": "silent_reply_control"');
    expect(findings).toContain('"renderAsText": false');
    expect(findings).not.toContain("NO_REPLY");
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

  it("suppresses raw source bodies in parent-visible findings and points at quarantine metadata", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-child-findings-"));
    const previous = process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_DIR;
    const previousAllowUnsafe = process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_ALLOW_UNSAFE_FOR_TEST;
    process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_DIR = path.join(tmpRoot, "quarantine");
    process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_ALLOW_UNSAFE_FOR_TEST = "1";
    try {
      const rawSource = [
        "import { hidden } from './secret.js';",
        "export function secret() {",
        'const sentinel = "DO_NOT_INJECT_PARENT";',
        "if (hidden) {",
        "return sentinel;",
        "}",
        "for (const item of [1, 2]) {",
        "return String(item);",
        "}",
      ].join("\n");
      const findings = buildChildCompletionFindings([
        {
          childSessionKey: "agent:main:subagent:raw",
          task: "raw source task",
          createdAt: 1,
          frozenResultText: rawSource,
          outcome: { status: "ok" },
        },
      ]);

      expect(findings).toContain("Child result summary (raw body quarantined)");
      expect(findings).toContain("normalizedState=MALFORMED");
      expect(findings).toContain("quarantineArtifact=");
      expect(findings).toContain("quarantineSha256=");
      expect(findings).not.toContain("DO_NOT_INJECT_PARENT");
      const quarantineFiles = fs.readdirSync(path.join(tmpRoot, "quarantine"));
      expect(quarantineFiles.some((name) => name.endsWith(".json"))).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_DIR;
      } else {
        process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_DIR = previous;
      }
      if (previousAllowUnsafe === undefined) {
        delete process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_ALLOW_UNSAFE_FOR_TEST;
      } else {
        process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_ALLOW_UNSAFE_FOR_TEST = previousAllowUnsafe;
      }
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("suppresses concise legacy freeform child bodies in parent-visible findings", () => {
    const rawBody = "completed the task";
    const findings = buildChildCompletionFindings([
      {
        childSessionKey: "agent:main:subagent:freeform",
        task: "freeform task",
        createdAt: 1,
        frozenResultText: rawBody,
        outcome: { status: "ok" },
      },
    ]);

    expect(findings).toContain("Child result summary (raw body quarantined)");
    expect(findings).toContain("contractVerdict=MISSING_VERDICT_SCHEMA");
    expect(findings).not.toContain(rawBody);
    expect(findings).toContain("quarantineArtifact=");
  });
});
