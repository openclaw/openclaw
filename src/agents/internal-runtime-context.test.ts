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

  it("strips a standalone next-turn runtime-context preface echoed by the model", () => {
    const input = [
      "OpenClaw runtime context for the immediately preceding user message.",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
    ].join("\n");

    expect(stripInternalRuntimeContext(input)).toBe("");
  });

  it("strips next-turn preface and preserves visible reply that follows", () => {
    const input = [
      "OpenClaw runtime context for the immediately preceding user message.",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "",
      "Hey Jim, how can I help?",
    ].join("\n");

    expect(stripInternalRuntimeContext(input)).toBe("Hey Jim, how can I help?");
  });

  it("strips a runtime-event preface echoed by the model", () => {
    const input = [
      "Some preceding output.",
      "",
      "OpenClaw runtime event.",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "",
      "Tail content.",
    ].join("\n");

    expect(stripInternalRuntimeContext(input)).toBe(
      ["Some preceding output.", "", "Tail content."].join("\n"),
    );
  });

  it("strips multiple preface occurrences in the same text", () => {
    const input = [
      "First reply.",
      "",
      "OpenClaw runtime context for the immediately preceding user message.",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "",
      "Middle.",
      "",
      "OpenClaw runtime event.",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "",
      "End.",
    ].join("\n");

    expect(stripInternalRuntimeContext(input)).toBe(
      ["First reply.", "", "Middle.", "", "End."].join("\n"),
    );
  });

  it("does not strip prose that merely mentions the preface phrasing inline", () => {
    const input =
      "I see the OpenClaw runtime context for the immediately preceding user message. came up earlier — should we look at that?";
    expect(stripInternalRuntimeContext(input)).toBe(input);
  });

  it("does not strip when extra characters follow the privacy notice on the same line", () => {
    // Model echo where the privacy-notice line is continued with additional
    // text on the same line. Without an end-of-line boundary check the strip
    // would land in the middle of the line and leak the trailing fragment.
    const input = [
      "OpenClaw runtime context for the immediately preceding user message.",
      "This context is runtime-generated, not user-authored. Keep internal details private. [ack]",
      "",
      "Visible reply.",
    ].join("\n");
    expect(stripInternalRuntimeContext(input)).toBe(input);
  });

  it("does not strip when only the privacy notice line appears without a header above it", () => {
    const input = [
      "Reply to user.",
      "",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
    ].join("\n");
    expect(stripInternalRuntimeContext(input)).toBe(input);
  });

  it("hasInternalRuntimeContext detects new preface headers when paired with the privacy notice", () => {
    expect(
      hasInternalRuntimeContext(
        [
          "OpenClaw runtime context for the immediately preceding user message.",
          "This context is runtime-generated, not user-authored. Keep internal details private.",
        ].join("\n"),
      ),
    ).toBe(true);

    expect(
      hasInternalRuntimeContext(
        [
          "OpenClaw runtime event.",
          "This context is runtime-generated, not user-authored. Keep internal details private.",
        ].join("\n"),
      ),
    ).toBe(true);

    expect(
      hasInternalRuntimeContext(
        "OpenClaw runtime context for the immediately preceding user message.",
      ),
    ).toBe(false);

    expect(
      hasInternalRuntimeContext(
        "Inline mention of OpenClaw runtime event. should not count as a block.",
      ),
    ).toBe(false);
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
