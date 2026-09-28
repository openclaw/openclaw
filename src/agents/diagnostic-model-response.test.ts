import { describe, expect, it } from "vitest";
import { resolveDiagnosticModelResponse } from "./diagnostic-model-response.js";
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

describe("CLI multi-result turns", () => {
  it("records only the last result, not the cumulative turn text", () => {
    expect(
      resolveDiagnosticModelResponse(
        result({
          finalAssistantRawText: "Checking now\nDone",
          finalAssistantMessageRawText: "Done",
        }),
      ),
    ).toBe("Done");
  });
});

describe("tool-only turns", () => {
  const sent = [
    { tool: "message", provider: "slack", text: "Done, 3 restarted", sourceReplyFinal: true },
  ];

  it("records the model's final NO_REPLY, never the message-tool text", () => {
    expect(
      resolveDiagnosticModelResponse({
        ...result({ finalAssistantRawText: "NO_REPLY" }),
        messagingToolSentTargets: sent,
        messagingToolSourceReplyPayloads: [{ text: "Done", sourceReplyFinal: true }],
      }),
    ).toBe("NO_REPLY");
  });

  it("records nothing when the final message is empty, even with a delivery mirror", () => {
    expect(
      resolveDiagnosticModelResponse({
        ...result({ finalAssistantVisibleText: "Done, 3 restarted" }),
        messagingToolSentTargets: sent,
      }),
    ).toBeUndefined();
  });

  it("never records earlier turn text the runner substituted for an empty final message", () => {
    expect(
      resolveDiagnosticModelResponse({
        ...result({ finalAssistantRawText: "Checking now", finalAssistantRawTextIsFallback: true }),
        messagingToolSentTargets: sent,
      }),
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
