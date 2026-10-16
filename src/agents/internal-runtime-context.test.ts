/**
 * Regression coverage for internal runtime-context stripping.
 * Verifies protected delimiters, legacy blocks, and custom-message filtering.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  escapeInternalRuntimeContextDelimiters,
  hasInternalRuntimeContext,
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  OPENCLAW_RUNTIME_CONTEXT_NOTICE,
  relocateCurrentRuntimeContextCarrierToTail,
  stripInternalRuntimeContext,
} from "./internal-runtime-context.js";

type TestMessage = {
  role: string;
  content: string;
  customType?: string;
  details?: { source: string };
};

function carrier(content = "runtime ctx"): TestMessage {
  return {
    role: "custom",
    customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
    content,
    details: { source: "openclaw-runtime-context" },
  };
}
function user(content: string): TestMessage {
  return { role: "user", content };
}
function assistant(content: string): TestMessage {
  return { role: "assistant", content };
}
function toolResult(content: string): TestMessage {
  return { role: "toolResult", content };
}

function createDeterministicRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("internal runtime context codec", () => {
  it("strips the current delimiter-free carrier without matching inline mentions", () => {
    expect(
      stripInternalRuntimeContext(
        "Visible intro\n\nOpenClaw runtime context:\nprivate current-turn facts\nEnd OpenClaw runtime context.\n\nVisible outro",
      ),
    ).toBe("Visible intro\n\nVisible outro");
    expect(
      stripInternalRuntimeContext("The phrase OpenClaw runtime context: is ordinary text."),
    ).toBe("The phrase OpenClaw runtime context: is ordinary text.");
  });

  it("strips an unfinished current carrier from previews and final output", () => {
    const text = "OpenClaw runtime context:\nThis phrase is part of the answer.";
    expect(stripInternalRuntimeContext(text)).toBe("");
    expect(stripInternalRuntimeContext(text, { streaming: true })).toBe("");
  });

  it("strips multiple marked internal runtime blocks and preserves surrounding text", () => {
    const first = [
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "first secret",
      INTERNAL_RUNTIME_CONTEXT_END,
    ].join("\n");
    const second = [
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "second secret",
      INTERNAL_RUNTIME_CONTEXT_END,
    ].join("\n");
    const input = ["Visible intro", "", first, "", "Visible middle", "", second].join("\n");

    expect(stripInternalRuntimeContext(input)).toBe("Visible intro\n\nVisible middle");
  });

  it("strips an unterminated internal runtime block from display", () => {
    const input = [
      "Visible intro",
      "",
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "secret runtime context",
      "",
      "Visible-looking tail",
    ].join("\n");

    expect(stripInternalRuntimeContext(input)).toBe("Visible intro");
  });

  it("withholds trailing marker prefixes only in cumulative previews", () => {
    for (const marker of [INTERNAL_RUNTIME_CONTEXT_BEGIN, INTERNAL_RUNTIME_CONTEXT_END]) {
      for (let length = 1; length < marker.length; length += 1) {
        const prefix = marker.slice(0, length);
        expect(stripInternalRuntimeContext(`Visible\n  ${prefix}`, { streaming: true })).toBe(
          "Visible",
        );
        expect(stripInternalRuntimeContext(prefix)).toBe(prefix);
      }
    }
    expect(stripInternalRuntimeContext("Visible\n<ordinary", { streaming: true })).toBe(
      "Visible\n<ordinary",
    );
  });

  it.each([["runtime event", "OpenClaw runtime event."]])(
    "detects and strips the %s prompt preface",
    (_name, header) => {
      const preface = [header, OPENCLAW_RUNTIME_CONTEXT_NOTICE].join("\n");
      const input = [
        preface,
        "",
        INTERNAL_RUNTIME_CONTEXT_BEGIN,
        "secret runtime context",
        INTERNAL_RUNTIME_CONTEXT_END,
        "",
        "Visible reply",
      ].join("\n");

      expect(hasInternalRuntimeContext(preface)).toBe(true);
      expect(stripInternalRuntimeContext(preface)).toBe("");
      expect(stripInternalRuntimeContext(input)).toBe("Visible reply");
      expect(
        stripInternalRuntimeContext(
          ` \t${header}\r\n ${OPENCLAW_RUNTIME_CONTEXT_NOTICE} \r\n\r\nVisible reply`,
        ),
      ).toBe("Visible reply");
    },
  );

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
        const token = expectDefined(
          tokenPool[Math.floor(rng() * tokenPool.length)],
          "tokenPool[Math.floor(rng() * tokenPool.length)] test invariant",
        );
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

describe("relocateCurrentRuntimeContextCarrierToTail", () => {
  it("moves the carrier past tool-call/tool-result scaffolding to the absolute tail", () => {
    const messages = [
      carrier("meta"),
      user("active"),
      assistant("tool call"),
      toolResult("tool output"),
    ];
    const out = relocateCurrentRuntimeContextCarrierToTail(messages);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "custom"]);
    expect(out[out.length - 1]).toEqual(carrier("meta"));
  });

  it("leaves a carrier in place when there is no active user turn to anchor after", () => {
    const messages = [carrier("meta"), assistant("reply")];
    expect(relocateCurrentRuntimeContextCarrierToTail(messages)).toBe(messages);
  });
});
