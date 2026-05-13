import { describe, expect, it, vi } from "vitest";
import {
  buildCurrentTurnPrompt,
  buildCurrentTurnPromptContextPrefix,
  buildRuntimeContextSystemContext,
  queueRuntimeContextForNextTurn,
  resolveCurrentTurnPromptSubmission,
  resolveRuntimeContextPromptParts,
} from "./runtime-context-prompt.js";

describe("runtime context prompt submission", () => {
  it("keeps unchanged prompts as a normal user prompt", () => {
    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: "visible ask",
        transcriptPrompt: "visible ask",
      }),
    ).toEqual({ prompt: "visible ask" });
  });

  it("moves hidden runtime context out of the visible prompt", () => {
    const effectivePrompt = [
      "visible ask",
      "",
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "secret runtime context",
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    ].join("\n");

    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt,
        transcriptPrompt: "visible ask",
      }),
    ).toEqual({
      prompt: "visible ask",
      runtimeContext:
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret runtime context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    });
  });

  it("preserves prompt additions as hidden runtime context", () => {
    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: ["runtime prefix", "", "visible ask", "", "retry instruction"].join("\n"),
        transcriptPrompt: "visible ask",
      }),
    ).toEqual({
      prompt: "visible ask",
      runtimeContext: "runtime prefix\n\nretry instruction",
    });
  });

  it("uses a marker prompt for runtime-only events", () => {
    const parts = resolveRuntimeContextPromptParts({
      effectivePrompt: "internal event",
      transcriptPrompt: "",
    });

    expect(parts).toEqual({
      prompt: "Continue the OpenClaw runtime event.",
      runtimeContext: "internal event",
      runtimeOnly: true,
      runtimeSystemContext: [
        "OpenClaw runtime event.",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "internal event",
      ].join("\n"),
    });
  });

  it("uses current-turn context as prompt-local text", () => {
    expect(
      buildCurrentTurnPromptContextPrefix({
        text: "Conversation info (untrusted metadata):\n```json\n{}\n```",
      }),
    ).toBe("Conversation info (untrusted metadata):\n```json\n{}\n```");
  });

  it("omits empty current-turn context", () => {
    expect(buildCurrentTurnPromptContextPrefix(undefined)).toBe("");
    expect(buildCurrentTurnPromptContextPrefix({ text: "   " })).toBe("");
  });

  it("joins current-turn context and prompt with the requested separator", () => {
    expect(
      buildCurrentTurnPrompt({
        context: { text: "Current message:\n#34975 obviyus:", promptJoiner: " " },
        prompt: "What do you mean hidden?",
      }),
    ).toBe("Current message:\n#34975 obviyus: What do you mean hidden?");

    expect(
      buildCurrentTurnPrompt({
        context: { text: "Conversation context:" },
        prompt: "visible ask",
      }),
    ).toBe("Conversation context:\n\nvisible ask");
  });

  it("queues runtime context as a hidden next-turn custom message", async () => {
    const sentMessages: Array<{ content: string }> = [];
    const sendCustomMessage = vi.fn(async (message: { content: string }) => {
      sentMessages.push(message);
    });

    await queueRuntimeContextForNextTurn({
      session: { sendCustomMessage },
      runtimeContext: "secret runtime context",
    });

    expect(sendCustomMessage).toHaveBeenCalledWith(
      {
        customType: "openclaw.runtime-context",
        content: "secret runtime context",
        display: false,
        details: { source: "openclaw-runtime-context" },
      },
      { deliverAs: "nextTurn" },
    );
    expect(sentMessages[0]?.content).not.toContain(
      "OpenClaw runtime context for the immediately preceding user message.",
    );
    expect(sentMessages[0]?.content).not.toContain("not user-authored");
  });

  it("labels next-turn runtime context only when used as prompt-local system context", () => {
    const systemContext = buildRuntimeContextSystemContext("secret runtime context");

    expect(systemContext).toContain(
      "OpenClaw runtime context for the immediately preceding user message.",
    );
    expect(systemContext).toContain("not user-authored");
    expect(systemContext).toContain("secret runtime context");
  });

  it("labels runtime-only events as system context", async () => {
    const { buildRuntimeEventSystemContext } = await import("./runtime-context-prompt.js");

    expect(buildRuntimeEventSystemContext("internal event")).toContain("OpenClaw runtime event.");
    expect(buildRuntimeEventSystemContext("internal event")).toContain("not user-authored");
  });

  describe("resolveCurrentTurnPromptSubmission", () => {
    it("passes through when no channel current-turn context is set", () => {
      expect(
        resolveCurrentTurnPromptSubmission({
          effectivePrompt: "visible ask",
          transcriptPrompt: "visible ask",
          currentTurnContext: undefined,
        }),
      ).toEqual({ prompt: "visible ask" });
    });

    it("routes channel metadata into hidden runtime context, not the visible prompt", () => {
      expect(
        resolveCurrentTurnPromptSubmission({
          effectivePrompt: "visible ask",
          transcriptPrompt: "visible ask",
          currentTurnContext: {
            text: "Conversation info (untrusted metadata):\n```json\n{}\n```",
          },
        }),
      ).toEqual({
        prompt: "visible ask",
        runtimeContext: "Conversation info (untrusted metadata):\n```json\n{}\n```",
      });
    });

    it("combines channel metadata with existing hidden runtime context", () => {
      const effectivePrompt = [
        "visible ask",
        "",
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
        "secret runtime context",
        "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      ].join("\n");

      const parts = resolveCurrentTurnPromptSubmission({
        effectivePrompt,
        transcriptPrompt: "visible ask",
        currentTurnContext: { text: "Conversation info: chat 8719706209" },
      });

      expect(parts.prompt).toBe("visible ask");
      expect(parts.runtimeContext).toBe(
        "Conversation info: chat 8719706209\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret runtime context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      );
      expect(parts.runtimeOnly).toBeUndefined();
    });

    it("ignores whitespace-only channel context", () => {
      expect(
        resolveCurrentTurnPromptSubmission({
          effectivePrompt: "visible ask",
          transcriptPrompt: "visible ask",
          currentTurnContext: { text: "   " },
        }),
      ).toEqual({ prompt: "visible ask" });
    });

    it("preserves runtime-only event semantics without disturbing the system-prompt route", () => {
      const parts = resolveCurrentTurnPromptSubmission({
        effectivePrompt: "internal event",
        transcriptPrompt: "",
        currentTurnContext: { text: "Conversation info: chat 8719706209" },
      });

      // Runtime-event turns deliver hidden context via the system prompt (not next-turn custom
      // messages), so the helper leaves them unchanged. Channel metadata on a runtime-only turn
      // is an out-of-scope edge case that pre-dates this fix.
      expect(parts.prompt).toBe("Continue the OpenClaw runtime event.");
      expect(parts.runtimeOnly).toBe(true);
      expect(parts.runtimeContext).toBe("internal event");
      expect(parts.runtimeSystemContext).toContain("OpenClaw runtime event.");
      expect(parts.runtimeSystemContext).toContain("internal event");
    });

    it("does not promote channel metadata to system context for normal user turns", () => {
      const parts = resolveCurrentTurnPromptSubmission({
        effectivePrompt: "visible ask",
        transcriptPrompt: "visible ask",
        currentTurnContext: { text: "Conversation info: chat 8719706209" },
      });

      expect(parts.runtimeSystemContext).toBeUndefined();
    });
  });
});
