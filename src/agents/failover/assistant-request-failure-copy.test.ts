import { describe, expect, it } from "vitest";
import { decodePostgresError } from "../../infra/postgres-sync/protocol.js";
import { formatUserFacingAssistantErrorText } from "../embedded-agent-helpers/error-text.js";
import { isNonProviderRuntimeCoordinationError } from "../failover-error.js";
import { makeAssistantMessageFixture as makeAssistant } from "../test-helpers/assistant-message-fixtures.js";
import {
  ERROR_DETAILS_HINT,
  PROVIDER_SCHEMA_REJECTION_USER_TEXT,
  renderAssistantRequestFailureCopy,
  renderRecordedAssistantFailureCopy,
  renderFormatErrorCopy,
  renderRuntimeCoordinationFailureCopy,
} from "./assistant-request-failure-copy.js";
import { isAuthErrorMessage } from "./message-patterns.js";

describe("renderAssistantRequestFailureCopy", () => {
  const runFailure =
    "⚠️ OpenClaw couldn't finish this reply. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.";
  const live = (fields: Parameters<typeof makeAssistant>[0]) =>
    formatUserFacingAssistantErrorText(makeAssistant(fields));
  const copies = (assistant: ReturnType<typeof makeAssistant>) => [
    formatUserFacingAssistantErrorText(assistant),
    renderRecordedAssistantFailureCopy(assistant),
  ];
  const loading = (fields: Parameters<typeof makeAssistant>[0]) =>
    makeAssistant({
      errorCode: "model_load_failed",
      errorMessage: "PRIVATE_DETAIL",
      errorBody: '{"requestedContextLength":49152}',
      ...fields,
    });
  function expectBoth(expected: string, fields: Parameters<typeof makeAssistant>[0]) {
    expect(copies(makeAssistant(fields))).toEqual([expected, expected]);
  }

  it("preserves approval-expiry guidance in assistant history", () => {
    const message =
      "Codex node execution approval expired before a decision. Retry the action and approve the new request.";
    const errorMessage = message + " | INVALID_REQUEST";
    expectBoth(`⚠️ ${message}`, { errorMessage, errorCode: "INVALID_REQUEST" });
    expect(isAuthErrorMessage(errorMessage)).toBe(false);
  });

  it.each([
    [
      { errorMessage: "Invalid session transcript entry: model_change PRIVATE_CANARY" },
      "OpenClaw couldn't read this conversation's history. Ask the Gateway operator to try `openclaw doctor --fix`. If it still fails, preserve the history and contact support with the Gateway logs.",
    ],
    [
      { errorCode: "incomplete_tool_call", errorMessage: "PRIVATE_PROVIDER_DETAIL" },
      "⚠️ The task couldn't finish. Some actions may have completed; check their results before continuing.",
    ],
    [{ errorMessage: '{"error":{"message":"database is locked PRIVATE_CANARY"}}' }, runFailure],
  ])("renders safe live guidance for %j", (fields, expected) => {
    expect(live(fields)).toBe(expected);
  });

  it("gives useful storage guidance without internal details", () => {
    const copy = live({ errorMessage: "disk I/O error" });
    expect(copy).toContain("couldn't save");
    expect(copy).toContain("Check the storage");
    expect(copy).toContain("openclaw logs --follow");
    expect(copy).not.toMatch(/SQLite|openai\/test-model|I\/O/);
  });

  it("gives the same reconciliation guidance in live replies and saved history", () => {
    const assistant = makeAssistant({
      errorMessage: "Session actor requires reconciliation before another command",
    });
    const copy = formatUserFacingAssistantErrorText(assistant);
    expect(copy).toContain("reopen the conversation");
    expect(copy).toContain("restart OpenClaw");
    expect(copy).not.toContain("Session actor");
    expect(renderRecordedAssistantFailureCopy(assistant)).toBe(copy);
  });

  it.each([
    ["user request", "57014"],
    ["statement timeout", "57014"],
    ["user request", undefined],
  ])("retains storage guidance for %s (code=%s) in live and saved replies", (cause, errorCode) => {
    const error = decodePostgresError({
      name: "error",
      code: "57014",
      message: `canceling statement due to ${cause} PRIVATE_STORAGE_DETAIL`,
    });
    expectBoth(
      `⚠️ PostgreSQL canceled a database operation or its statement timed out. Check the conversation for completed work before trying again. If it happens again, ask the operator to check PostgreSQL timeouts and server activity. ${ERROR_DETAILS_HINT}`,
      {
        errorMessage: error.message,
        errorType: error.name,
        errorCode,
      },
    );
  });

  it("keeps provider-owned 57014 errors out of storage cancellation handling", () => {
    expectBoth("⚠️ The AI service needs a short break. Please try again in a few minutes.", {
      errorCode: "57014",
      errorType: "rate_limit_error",
      errorMessage: "Rate limit reached PRIVATE_PROVIDER_DETAIL",
    });
  });

  it("renders loading facts consistently in live replies and saved history without provider prose", () => {
    const assistant = loading({
      model: "local/model",
      errorMessage: "PRIVATE_PROVIDER_DETAIL",
      errorBody: JSON.stringify({
        requestedContextLength: 49152,
        message: "PRIVATE_PROVIDER_DETAIL",
        nextStep: "PRIVATE_INJECTION",
      }),
    });
    const expected = String.raw`Could not load model "local\/model" with 49152 context tokens. Wait for loading to finish on the model server, then retry, or lower the model's configured context size.`;
    expect(copies(assistant)).toEqual([expected, expected]);
  });

  it("bounds, redacts, and escapes loading model labels", () => {
    const assistant = loading({
      model: `local/[model]\nAuthorization: Bearer sk-test ${"x".repeat(800)}`,
    });
    const copy = formatUserFacingAssistantErrorText(assistant);
    expect(renderRecordedAssistantFailureCopy(assistant)).toBe(copy);
    expect(copy).toContain(String.raw`local\/\[model\]`);
    expect(copy).not.toMatch(/sk-test|PRIVATE_DETAIL|\n/);
    expect(copy.length).toBeLessThan(500);
  });

  it("keeps malformed loading facts private", () => {
    const assistant = loading({
      errorBody: JSON.stringify({ requestedContextLength: Number.MAX_SAFE_INTEGER + 1 }),
    });
    expect(formatUserFacingAssistantErrorText(assistant)).toBe(runFailure);
    expect(renderRecordedAssistantFailureCopy(assistant)).toBeUndefined();
  });

  it("renders bounded guidance for a typed runtime code", () => {
    const code = "runner-offline";
    const error = Object.assign(new Error("private runtime diagnostic"), {
      name: "WorkerRunnerUnavailableError",
      code,
    });
    const runtimeCode = isNonProviderRuntimeCoordinationError(error) ? code : undefined;
    expect(renderRuntimeCoordinationFailureCopy(runtimeCode)).toBe(
      "⚠️ The device runner is offline. Reconnect it, retry later, or bring the session back to this gateway.",
    );
  });

  it("gives recovery guidance after a tool-result request is rejected", () => {
    const detail = "A maximum of 4 blocks with cache_control may be provided. Found 5.";
    const errorBody = JSON.stringify({
      error: {
        message: "All target providers failed.",
        attempts: [
          { status: 400, details: { error: { type: "invalid_request_error", message: detail } } },
        ],
      },
    });
    expect(
      live({
        errorCode: "400",
        errorMessage: `400: ${errorBody}`,
        errorBody,
      }),
    ).toBe(
      "The AI service couldn't accept this conversation. Start a new conversation with /new, or choose another model in the Control UI.",
    );
  });

  it("gives the custom-model opt-out for rejected reasoning controls", () => {
    const detail = "'reasoning_effort' is not supported for this model";
    expectBoth(
      "This model endpoint does not support reasoning_effort. Set compat.supportsReasoningEffort: false on this model in your custom provider configuration and try again.",
      {
        provider: "custom-local",
        model: "reasoning-model",
        errorMessage: `400 ${JSON.stringify({ error: { type: "invalid_request_error", message: detail } })}`,
      },
    );
  });

  it("preserves the provider rejection across live and saved replies", () => {
    expectBoth(String.raw`LLM request rejected: Invalid service\_tier argument`, {
      errorMessage: "Invalid service_tier argument",
      errorType: "invalid_request_error",
      errorBody: "PRIVATE_NON_ERROR_BODY",
    });
  });

  it("explains an Ollama embedding model rejection in live and saved replies", () => {
    const errorBody = JSON.stringify({ error: '"bge-m3:latest" does not support chat' });
    expectBoth(
      String.raw`bge\-m3\:latest is an embedding model and cannot chat; pick a chat model with /model (or remove it from models.providers.ollama.models).`,
      { provider: "ollama", model: "bge-m3:latest", errorMessage: "400 " + errorBody, errorBody },
    );
  });

  it("unwraps direct and nested upstream rejections with status prefix", () => {
    const prefix = "422 Unprocessable Entity: ";
    const inner = JSON.stringify({
      error: { type: "invalid_request_error", message: "Unsupported parameter" },
      request: { input: "PRIVATE_PROMPT" },
    });
    for (const errorMessage of [
      prefix + inner,
      JSON.stringify({ error: { type: "invalid_request_error", message: prefix + inner } }),
    ]) {
      expectBoth("LLM request rejected: Unsupported parameter", { errorMessage });
    }
  });

  it.each([
    JSON.stringify({
      error: { type: "invalid_request_error", message: '{"input":"PRIVATE_PROMPT"}' },
    }),
    "422 Unprocessable Content: <html>PRIVATE_PROMPT</html>",
    '400 Bad Request: [{"input":"PRIVATE_PROMPT"}]',
    '422 Unprocessable Entity: [{"input":"PRIVATE_PROMPT"',
  ])("keeps raw response bodies out of live and saved replies: %s", (errorMessage) => {
    for (const copy of copies(makeAssistant({ errorMessage }))) {
      expect(copy).not.toContain("PRIVATE");
    }
    expect(renderFormatErrorCopy(errorMessage)).toBe(PROVIDER_SCHEMA_REJECTION_USER_TEXT);
  });

  it("handles partial model context", () => {
    expect(renderAssistantRequestFailureCopy({ model: "test-model" })).toBe(runFailure);
  });
});
