import { describe, expect, it } from "vitest";
import {
  resolveDiagnosticModelResponse,
  resolveDiagnosticSourceReplyText,
} from "./diagnostic-model-response.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";

function result(meta: Partial<EmbeddedAgentRunResult["meta"]>): EmbeddedAgentRunResult {
  return { payloads: [], meta: { durationMs: 0, ...meta } } as EmbeddedAgentRunResult;
}

describe("resolveDiagnosticModelResponse", () => {
  it("keeps sentinel model responses verbatim", () => {
    expect(resolveDiagnosticModelResponse(result({ finalAssistantRawText: "NO_REPLY" }))).toBe(
      "NO_REPLY",
    );
  });

  it("excludes host-generated blocked-run text", () => {
    expect(
      resolveDiagnosticModelResponse(
        result({
          livenessState: "blocked",
          finalAssistantRawText: "Blocked by before_agent_run policy",
        }),
        "delivered",
      ),
    ).toBeUndefined();
  });

  it("keeps genuine partial model output from errored runs", () => {
    expect(
      resolveDiagnosticModelResponse(
        result({
          finalAssistantRawText: "partial answer",
          error: { kind: "incomplete_turn", message: "stream cut" },
        } as Partial<EmbeddedAgentRunResult["meta"]>),
      ),
    ).toBe("partial answer");
  });

  it("never substitutes delivered payload text for a missing model response", () => {
    expect(
      resolveDiagnosticModelResponse({
        ...result({}),
        payloads: [{ text: "Gateway restarting…" }, { text: "hook reply" }],
      }),
    ).toBeUndefined();
  });
});

describe("delivery mirror", () => {
  it("prefers the model's message-tool text over the CLI delivery mirror", () => {
    expect(
      resolveDiagnosticModelResponse({
        ...result({ finalAssistantVisibleText: "Deploy finished." }),
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            text: "[[reply_to_current]] Deploy finished.",
            sourceReplyFinal: true,
          },
        ],
      }),
    ).toBe("[[reply_to_current]] Deploy finished.");
    expect(
      resolveDiagnosticModelResponse(result({ finalAssistantVisibleText: "mirror only" })),
    ).toBeUndefined();
  });
});

describe("hook-handled turns", () => {
  it("never captures hook-authored text as a model response", () => {
    expect(
      resolveDiagnosticModelResponse({
        ...result({ finalAssistantRawText: "hook reply", providerStarted: false }),
        payloads: [{ text: "hook reply" }],
      }),
    ).toBeUndefined();
  });

  it("never captures hook-authored silence as a model response", () => {
    expect(
      resolveDiagnosticModelResponse(
        result({ finalAssistantRawText: "NO_REPLY", providerStarted: false }),
      ),
    ).toBeUndefined();
    expect(resolveDiagnosticModelResponse(result({ finalAssistantRawText: "NO_REPLY" }))).toBe(
      "NO_REPLY",
    );
  });
});

describe("resolveDiagnosticSourceReplyText", () => {
  it("includes confirmed internal and external final source replies only", () => {
    expect(
      resolveDiagnosticSourceReplyText({
        messagingToolSourceReplyPayloads: [
          { text: "internal reply", sourceReplyFinal: true },
          { text: "internal progress", sourceReplyFinal: false },
        ],
        messagingToolSentTargets: [
          { tool: "message", provider: "slack", text: "external reply", sourceReplyFinal: true },
          { tool: "message", provider: "slack", text: "progress", sourceReplyFinal: false },
          { tool: "message", provider: "telegram", to: "other-chat", text: "elsewhere" },
        ],
      }),
    ).toBe("internal reply\nexternal reply");
  });

  it("is the default fallback for tool-only runs and never outranks model text", () => {
    const sent = [
      { tool: "message", provider: "slack", text: "external reply", sourceReplyFinal: true },
    ];
    expect(
      resolveDiagnosticModelResponse({
        ...result({}),
        messagingToolSentTargets: sent,
      }),
    ).toBe("external reply");
    expect(
      resolveDiagnosticModelResponse({
        ...result({ finalAssistantRawText: "NO_REPLY" }),
        messagingToolSentTargets: sent,
      }),
    ).toBe("NO_REPLY");
  });
});
