import { describe, expect, it } from "vitest";
import {
  escapeInternalRuntimeContextDelimiters,
  hasInternalRuntimeContext,
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  stripInternalRuntimeContext,
} from "./internal-runtime-context.js";

function createDeterministicRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("internal runtime context codec", () => {
  it("strips a marked internal runtime block and preserves surrounding text", () => {
    const input = [
      "Visible intro",
      "",
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "OpenClaw runtime context (internal):",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "",
      "[Internal task completion event]",
      "source: subagent",
      INTERNAL_RUNTIME_CONTEXT_END,
      "",
      "Visible outro",
    ].join("\n");

    expect(stripInternalRuntimeContext(input)).toBe("Visible intro\n\nVisible outro");
  });

  it("detects canonical runtime context and ignores inline marker mentions", () => {
    expect(
      hasInternalRuntimeContext(
        `${INTERNAL_RUNTIME_CONTEXT_BEGIN}\ninternal\n${INTERNAL_RUNTIME_CONTEXT_END}`,
      ),
    ).toBe(true);
    expect(
      hasInternalRuntimeContext(
        `Inline token ${INTERNAL_RUNTIME_CONTEXT_BEGIN} should not count as a block marker.`,
      ),
    ).toBe(false);
  });

  it("strips a modern runtime context wrapper and preserves the visible reply", () => {
    const input = [
      "OpenClaw runtime context for the immediately preceding user message.",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "",
      "An async command you ran earlier has completed. The command completion details are:",
      'Exec completed (wild-moo, code 0) :: {"status":"healthy"}',
      "",
      "Please relay the command output to the user in a helpful way.",
      "",
      "Three async commands completed:",
      "1. wild-moo — OpenClaw healthy.",
    ].join("\n");

    expect(hasInternalRuntimeContext(input)).toBe(true);
    expect(stripInternalRuntimeContext(input)).toBe(
      ["Three async commands completed:", "1. wild-moo — OpenClaw healthy."].join("\n"),
    );
  });

  it("strips modern conversation metadata blocks and preserves surrounding text", () => {
    const input = [
      "Visible intro.",
      "",
      "OpenClaw runtime context for the immediately preceding user message.",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "",
      "Conversation info (untrusted metadata):",
      "```json",
      '{"chat_id":"telegram:-1003710118964","message_id":"14398"}',
      "```",
      "",
      "Sender (untrusted metadata):",
      "```json",
      '{"name":"Paul Frederiksen"}',
      "```",
      "",
      "Visible reply.",
    ].join("\n");

    expect(stripInternalRuntimeContext(input)).toBe("Visible intro.\n\nVisible reply.");
  });

  it("preserves a visible JSON reply after an echoed modern preface", () => {
    const input = [
      "OpenClaw runtime context for the immediately preceding user message.",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "",
      '{"status":"ok","message":"done"}',
    ].join("\n");

    expect(stripInternalRuntimeContext(input)).toBe('{"status":"ok","message":"done"}');
  });

  it("preserves a visible fenced reply after an echoed modern preface", () => {
    const input = [
      "OpenClaw runtime context for the immediately preceding user message.",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "",
      "```json",
      '{"status":"ok"}',
      "```",
    ].join("\n");

    expect(stripInternalRuntimeContext(input)).toBe(
      ["```json", '{"status":"ok"}', "```"].join("\n"),
    );
  });

  it("strips structured metadata before preserving a visible JSON reply", () => {
    const input = [
      "OpenClaw runtime context for the immediately preceding user message.",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "",
      "Conversation info (untrusted metadata):",
      "```json",
      '{"chat_id":"telegram:-1003710118964"}',
      "```",
      "",
      '{"answer":"visible"}',
    ].join("\n");

    expect(stripInternalRuntimeContext(input)).toBe('{"answer":"visible"}');
  });

  it("strips markdown-style inbound context and exec state blocks", () => {
    const input = [
      "OpenClaw runtime context for the immediately preceding user message.",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "",
      "## Inbound Context (trusted metadata)",
      "```json",
      '{"channel":"webchat","messageId":"m_123"}',
      "```",
      "",
      "## Current Exec Session State",
      "",
      "Current session exec defaults: workdir=/repo, shell=bash",
      "",
      "Current elevated level: none",
      "",
      "If the user asks to run a command, use the exec tool.",
      "",
      "Visible reply.",
    ].join("\n");

    expect(stripInternalRuntimeContext(input)).toBe("Visible reply.");
  });

  it("fuzzes delimiter injection and nested marker handling deterministically", () => {
    const rng = createDeterministicRng(0xc0ff_ee42);
    const tokenPool = [
      "plain output line",
      "status: ok",
      `inline ${INTERNAL_RUNTIME_CONTEXT_BEGIN} mention`,
      `inline ${INTERNAL_RUNTIME_CONTEXT_END} mention`,
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      INTERNAL_RUNTIME_CONTEXT_END,
      "more details",
    ];

    for (let index = 0; index < 120; index++) {
      const lineCount = 4 + Math.floor(rng() * 12);
      const payloadLines: string[] = [];
      for (let i = 0; i < lineCount; i++) {
        const token = tokenPool[Math.floor(rng() * tokenPool.length)];
        payloadLines.push(token);
      }
      const escapedPayload = payloadLines.map((line) =>
        escapeInternalRuntimeContextDelimiters(line),
      );

      const visible = `Visible reply ${index}`;
      const wrapped = [
        INTERNAL_RUNTIME_CONTEXT_BEGIN,
        ...escapedPayload,
        INTERNAL_RUNTIME_CONTEXT_END,
        "",
        visible,
      ].join("\n");

      const stripped = stripInternalRuntimeContext(wrapped);
      expect(stripped).toBe(visible);
      expect(stripped).not.toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);
      expect(stripped).not.toContain(INTERNAL_RUNTIME_CONTEXT_END);
    }
  });
});
