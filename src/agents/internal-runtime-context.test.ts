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
  resolvePendingRuntimeContextReplay,
  stripHistoricalRuntimeContextCustomMessages,
  stripInternalRuntimeContext,
  SYSTEM_UPDATE_MESSAGE_CUSTOM_TYPE,
} from "./internal-runtime-context.js";

function carrier(content = "runtime ctx") {
  return {
    role: "custom",
    customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
    content,
    details: { source: "openclaw-runtime-context" },
  };
}
function message(role: string, content: string) {
  return { role, content };
}
function block(...lines: string[]): string {
  return [INTERNAL_RUNTIME_CONTEXT_BEGIN, ...lines, INTERNAL_RUNTIME_CONTEXT_END].join("\n");
}

function createDeterministicRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("internal runtime context codec", () => {
  it.each([
    ["", ""],
    ["<@U123> ordinary 🦞 text", "<@U123> ordinary 🦞 text"],
    [
      "<<<ordinary>>> <<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> ",
      "<<<ordinary>>> <<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> ",
    ],
    [INTERNAL_RUNTIME_CONTEXT_BEGIN, "[[OPENCLAW_INTERNAL_CONTEXT_BEGIN]]"],
    [INTERNAL_RUNTIME_CONTEXT_END, "[[OPENCLAW_INTERNAL_CONTEXT_END]]"],
    [
      `${INTERNAL_RUNTIME_CONTEXT_END}${INTERNAL_RUNTIME_CONTEXT_BEGIN}${INTERNAL_RUNTIME_CONTEXT_END}`,
      "[[OPENCLAW_INTERNAL_CONTEXT_END]][[OPENCLAW_INTERNAL_CONTEXT_BEGIN]][[OPENCLAW_INTERNAL_CONTEXT_END]]",
    ],
  ])("escapes only complete protected delimiters in %j", (input, expected) => {
    expect(escapeInternalRuntimeContextDelimiters(input)).toBe(expected);
  });

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
    const input = `Visible intro\n\n${block("first secret")}\n\nVisible middle\n\n${block("second secret")}`;
    expect(stripInternalRuntimeContext(input)).toBe("Visible intro\n\nVisible middle");
  });

  it("strips an unterminated internal runtime block from display", () => {
    const input = `Visible intro\n\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\nsecret runtime context\n\nVisible-looking tail`;
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

  it("detects and strips the runtime event prompt preface", () => {
    const header = "OpenClaw runtime event.";
    const preface = [header, OPENCLAW_RUNTIME_CONTEXT_NOTICE].join("\n");
    const input = `${preface}\n\n${block("secret runtime context")}\n\nVisible reply`;

    expect(hasInternalRuntimeContext(preface)).toBe(true);
    expect(stripInternalRuntimeContext(preface)).toBe("");
    expect(stripInternalRuntimeContext(input)).toBe("Visible reply");
    expect(
      stripInternalRuntimeContext(
        ` \t${header}\r\n ${OPENCLAW_RUNTIME_CONTEXT_NOTICE} \r\n\r\nVisible reply`,
      ),
    ).toBe("Visible reply");
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
      const payloadLines = Array.from({ length: lineCount }, () =>
        expectDefined(tokenPool[Math.floor(rng() * tokenPool.length)], "random token"),
      );
      const escapedPayload = payloadLines.map((line) =>
        escapeInternalRuntimeContextDelimiters(line),
      );

      const visible = `Visible reply ${index}`;
      const wrapped = `${block(...escapedPayload)}\n\n${visible}`;

      const stripped = stripInternalRuntimeContext(wrapped);
      expect(stripped).toBe(visible);
    }
  });
});

describe("relocateCurrentRuntimeContextCarrierToTail", () => {
  it("moves the carrier past tool-call/tool-result scaffolding to the absolute tail", () => {
    const messages = [
      carrier("meta"),
      message("user", "active"),
      message("assistant", "tool call"),
      message("toolResult", "tool output"),
    ];
    const out = relocateCurrentRuntimeContextCarrierToTail(messages);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "custom"]);
    expect(out[out.length - 1]).toEqual(carrier("meta"));
  });

  it("leaves a carrier in place when there is no active user turn to anchor after", () => {
    const messages = [carrier("meta"), message("assistant", "reply")];
    expect(relocateCurrentRuntimeContextCarrierToTail(messages)).toBe(messages);
  });
});

describe("resolvePendingRuntimeContextReplay", () => {
  it.each([false, true])(
    "keeps additive fallback context while reusing the persisted carrier (system update=%s)",
    (systemUpdate) => {
      const runtimeUpdate = (content: string) => ({
        role: "custom",
        customType: SYSTEM_UPDATE_MESSAGE_CUSTOM_TYPE,
        content,
        details: { kind: "runtime-context", turnScoped: true },
      });
      const original = { ...message("user", "Describe the image."), idempotencyKey: "image:user" };
      const primaryContext = systemUpdate
        ? runtimeUpdate("Primary context")
        : carrier("Primary context");
      const replacement = runtimeUpdate("Replacement snapshot");
      const fallbackContext = {
        ...runtimeUpdate("Fresh fallback instructions"),
        details: { kind: "runtime-context", turnScoped: true, replay: "append" },
      };
      const ordinaryContext = message("custom", "Unrelated queued context");

      const result = resolvePendingRuntimeContextReplay({
        messages: [original, primaryContext, message("assistant", "")],
        pendingContextMessages: [replacement, fallbackContext, ordinaryContext],
        persistedUserIdempotencyKey: original.idempotencyKey,
      });

      expect(result.persistedUserIndex).toBe(0);
      expect(result.replayPersistedCarrier).toBe(true);
      expect(result.pendingContextMessages).toEqual([fallbackContext, ordinaryContext]);
    },
  );
});

describe("additive fallback context lifetime", () => {
  it.each(["error", "aborted", "toolUse", "stop", "length"])(
    "retains context only for the owning turn across %s",
    (stopReason) => {
      const context = {
        role: "custom",
        customType: SYSTEM_UPDATE_MESSAGE_CUSTOM_TYPE,
        content: "Fresh fallback instructions",
        details: { kind: "runtime-context", turnScoped: true, replay: "append" },
      };
      const user = { ...message("user", "Describe the image."), idempotencyKey: "original" };
      const assistant = { ...message("assistant", ""), stopReason };
      const steering = { ...message("user", "Focus on the foreground."), idempotencyKey: "next" };
      const messages = [user, context, assistant, steering];
      expect(stripHistoricalRuntimeContextCustomMessages(messages, "original")).toEqual(messages);
      expect(stripHistoricalRuntimeContextCustomMessages(messages, "next")).toEqual([
        user,
        assistant,
        steering,
      ]);
      expect(stripHistoricalRuntimeContextCustomMessages(messages, "compacted-away")).toEqual([
        user,
        assistant,
        steering,
      ]);
      expect(
        stripHistoricalRuntimeContextCustomMessages([user, context, steering], "next"),
      ).toEqual([user, steering]);
    },
  );
});
