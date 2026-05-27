import { describe, expect, it } from "vitest";
import {
  buildCurrentInboundPrompt,
  buildCurrentInboundPromptContextPrefix,
  buildRuntimeContextCustomMessage,
  buildRuntimeContextSystemContext,
  resolveAttemptEmptyTranscriptMode,
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

  it("submits empty-transcript model prompts when persistence is suppressed separately", () => {
    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: "[OpenClaw room event]",
        transcriptPrompt: "",
        emptyTranscriptMode: "model-prompt",
      }),
    ).toEqual({
      prompt: "[OpenClaw room event]",
    });
  });

  it("uses current-turn context as prompt-local text", () => {
    expect(
      buildCurrentInboundPromptContextPrefix({
        text: "Conversation info (untrusted metadata):\n```json\n{}\n```",
      }),
    ).toBe("Conversation info (untrusted metadata):\n```json\n{}\n```");
  });

  it("omits empty current-turn context", () => {
    expect(buildCurrentInboundPromptContextPrefix(undefined)).toBe("");
    expect(buildCurrentInboundPromptContextPrefix({ text: "   " })).toBe("");
  });

  it("joins current-turn context and prompt with the requested separator", () => {
    expect(
      buildCurrentInboundPrompt({
        context: { text: "Current message:\n#34975 obviyus:", promptJoiner: " " },
        prompt: "What do you mean hidden?",
      }),
    ).toBe("Current message:\n#34975 obviyus: What do you mean hidden?");

    expect(
      buildCurrentInboundPrompt({
        context: { text: "Conversation context:" },
        prompt: "visible ask",
      }),
    ).toBe("Conversation context:\n\nvisible ask");
  });

  it("builds runtime context as prompt-local custom context before the current user prompt", () => {
    expect(buildRuntimeContextCustomMessage("secret runtime context")).toMatchObject({
      role: "custom",
      customType: "openclaw.runtime-context",
      content: [
        "OpenClaw runtime context for the immediately preceding user message.",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "secret runtime context",
      ].join("\n"),
      display: false,
      details: { source: "openclaw-runtime-context" },
    });
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

  describe("resolveAttemptEmptyTranscriptMode", () => {
    // The runtime-event mode routes the trigger payload through
    // `runtimeSystemContext` (the system prompt) because cron/heartbeat triggers
    // have no user-authored content. When a `before_prompt_build` hook supplies
    // `prependContext` or `appendContext`, that content is user-prompt by
    // contract, so the empty-transcript fallback must switch to "model-prompt"
    // or the hook's text leaks into the system prompt. (#87163)
    it("returns runtime-event by default", () => {
      expect(resolveAttemptEmptyTranscriptMode({})).toBe("runtime-event");
    });

    it("returns model-prompt when next-user persistence is suppressed", () => {
      expect(resolveAttemptEmptyTranscriptMode({ suppressNextUserMessagePersistence: true })).toBe(
        "model-prompt",
      );
    });

    it("returns model-prompt when a hook supplied prependContext", () => {
      expect(
        resolveAttemptEmptyTranscriptMode({
          hookPromptBuildResult: { prependContext: "user-visible note" },
        }),
      ).toBe("model-prompt");
    });

    it("returns model-prompt when a hook supplied appendContext", () => {
      expect(
        resolveAttemptEmptyTranscriptMode({
          hookPromptBuildResult: { appendContext: "user-visible note" },
        }),
      ).toBe("model-prompt");
    });

    it("returns runtime-event when only system-prompt hook fields are present", () => {
      expect(
        resolveAttemptEmptyTranscriptMode({
          hookPromptBuildResult: { prependContext: "", appendContext: "" },
        }),
      ).toBe("runtime-event");
    });

    it("chained with resolveRuntimeContextPromptParts: hook prependContext lands in user prompt on empty transcript (#87163)", () => {
      // Heartbeat/cron-style trigger where params.prompt is empty. After the
      // `before_prompt_build` hook runs, effectivePrompt contains the hook's
      // prependContext. The transcript-prompt is empty (no user-authored
      // message). Without the fix this hits the runtimeOnly branch and the
      // hook contribution ends up in `runtimeSystemContext` (system prompt).
      const hookResult = { prependContext: "Plugin context for THIS turn." };
      const effectivePrompt = `${hookResult.prependContext}\n\n`;

      const parts = resolveRuntimeContextPromptParts({
        effectivePrompt,
        transcriptPrompt: "",
        emptyTranscriptMode: resolveAttemptEmptyTranscriptMode({
          hookPromptBuildResult: hookResult,
        }),
      });

      expect(parts.runtimeOnly).toBeUndefined();
      expect(parts.runtimeSystemContext).toBeUndefined();
      expect(parts.prompt).toContain("Plugin context for THIS turn.");
    });
  });
});
