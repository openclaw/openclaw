import type { Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeResponsesFailedEvent,
  ResponsesStreamFailure,
  summarizeResponsesPayload,
  summarizeOpenAITransportError,
} from "./openai-responses-debug.js";

const failedEventModel = {
  provider: "openai",
  api: "openai-responses",
  id: "gpt-5.6-luna",
} as unknown as Model;

describe("OpenAI Responses payload debug summary", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["summary", "tools", "full-redacted"])(
    "keeps %s diagnostics free of prompt, tool, and nested provider-error content",
    (mode) => {
      vi.stubEnv("OPENCLAW_DEBUG_MODEL_PAYLOAD", mode);
      const privateText = "synthetic private prompt and tool result";
      const summary = summarizeResponsesPayload({
        apiKey: privateText,
        instructions: privateText,
        input: [
          { type: "message", role: "user", content: privateText },
          { type: "function_call", name: "exec", arguments: privateText },
          { type: "function_call_output", output: privateText },
        ],
        tools: [{ type: "function", name: "exec", description: privateText }],
      });
      expect(summary).toContain("tools=count=1 names=exec");
      expect(summary).toContain("inputItems=3");
      expect(summary).not.toContain(privateText);
      const failure = normalizeResponsesFailedEvent(
        { response: { error_details: { text: privateText } } },
        failedEventModel,
      );
      expect(failure.observation?.failureFieldNames).toEqual(["error_details"]);
      expect(JSON.stringify(failure.observation)).not.toContain(privateText);
      const error = Object.assign(new Error(privateText), {
        status: 503,
        code: "service_unavailable",
        cause: Object.assign(new Error(privateText), { code: "ECONNRESET" }),
      });
      const diagnostic = summarizeOpenAITransportError(error);
      expect(diagnostic).toContain("status=503 code=service_unavailable");
      expect(diagnostic).toContain("causeCode=ECONNRESET");
      expect(diagnostic).not.toContain(privateText);
      expect(summarizeOpenAITransportError(privateText)).not.toContain(privateText);
      expect(summarizeOpenAITransportError({ message: privateText })).not.toContain(privateText);
      const controller = new AbortController();
      controller.abort(new Error(privateText));
      expect(summarizeOpenAITransportError(error, controller.signal)).not.toContain(privateText);
      expect(
        summarizeOpenAITransportError({
          code: { output: privateText },
          type: privateText,
          cause: { name: privateText, code: { tool_arguments: privateText } },
        }),
      ).not.toContain(privateText);
    },
  );

  it.each([
    [{ name: "LlmIdleTimeoutError" }, "idle_timeout"],
    [{ name: "LlmNoProgressError" }, "no_progress"],
    [{ name: "FirstStreamEventTimeoutError" }, "first_event_timeout"],
    [new DOMException("private timeout text", "TimeoutError"), "request_deadline"],
    [{ code: "OPENCLAW_SESSION_WATCHDOG" }, "session_watchdog"],
    [{ code: "OPENCLAW_RESTART_ABORT" }, "restart"],
    [{ code: "ERR_STALE_GATEWAY_LIFECYCLE" }, "restart"],
    [{ code: "AGENT_RUN_SUPERSEDED_ABORT" }, "superseded"],
    [{ code: "OPENCLAW_DIRECT_ABORT" }, "caller_abort"],
    ["private caller text", "caller_abort"],
  ])(
    "classifies an aborted request as %j -> %s without copying reason text",
    (reason, expected) => {
      const controller = new AbortController();
      const error = new Error("private provider text");
      expect(summarizeOpenAITransportError(error, controller.signal)).not.toContain("abortReason=");
      controller.abort(reason);
      const summary = summarizeOpenAITransportError(error, controller.signal);
      expect(summary).toContain(`abortReason=${expected}`);
      expect(summary).not.toContain("private");
    },
  );

  it("reports function and hosted tool names without naming an empty function entry", () => {
    const summary = summarizeResponsesPayload({
      tools: [
        { type: "function", name: "exec" },
        { type: "function", function: { name: "wait" } },
        { type: "web_search" },
        { type: "function" },
      ],
    });

    expect(summary).toContain("tools=count=4 names=exec,wait,web_search");
  });

  it("reports compaction replay identities without exposing opaque content", () => {
    const summary = summarizeResponsesPayload({
      model: "gpt-5.6-sol",
      input: [
        { type: "message", role: "user", content: "hello" },
        {
          type: "compaction",
          id: "cmp-private-id",
          encrypted_content: "opaque-private-ciphertext",
        },
      ],
      context_management: [{ type: "compaction", compact_threshold: 700_000 }],
      service_tier: "priority",
      stream: true,
      store: true,
    });

    expect(summary).toContain("compactionItems=1");
    expect(summary).toContain("compactionInputIndexes=1");
    expect(summary).toContain("inputItems=2");
    expect(summary).toContain("inputItemShape=message:user,compaction");
    expect(summary).toMatch(/compactionIdHashes=[a-f0-9]{64}/u);
    expect(summary).toMatch(/compactionPayloadHashes=[a-f0-9]{64}/u);
    expect(summary).not.toContain("cmp-private-id");
    expect(summary).not.toContain("opaque-private-ciphertext");
  });

  it("reports an empty replay set for non-array input", () => {
    expect(summarizeResponsesPayload({ input: "hello" })).toContain(
      "compactionItems=0 compactionIdHashes=none compactionPayloadHashes=none compactionInputIndexes=none",
    );
  });
});

describe("normalizeResponsesFailedEvent", () => {
  it("preserves the structured provider error code on the failure and ResponsesStreamFailure (#117609)", () => {
    const summary = normalizeResponsesFailedEvent(
      {
        response: {
          id: "resp_failed",
          status: "failed",
          error: { code: "server_error", message: "provider failed" },
        },
      },
      failedEventModel,
    );
    // The prose message still embeds the code, but the structured code is now
    // preserved so downstream failover classification routes on it instead of
    // guessing from the prose.
    expect(summary.code).toBe("server_error");
    expect(summary.message).toBe("server_error: provider failed");
    expect(summary.responseId).toBe("resp_failed");

    const failure = new ResponsesStreamFailure(summary, undefined);
    expect(failure.code).toBe("server_error");
    expect(failure.message).toBe("server_error: provider failed");
    expect(failure.responseId).toBe("resp_failed");
  });

  it("omits code when the failed response has no error code", () => {
    const summary = normalizeResponsesFailedEvent(
      {
        response: {
          id: "resp_failed",
          status: "failed",
          error: { message: "provider failed" },
        },
      },
      failedEventModel,
    );
    expect(summary.code).toBeUndefined();
    expect(summary.message).toBe("unknown: provider failed");
  });
});
