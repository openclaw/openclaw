import { describe, expect, it } from "vitest";
import { decodePostgresError } from "../../infra/postgres-sync/protocol.js";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import { buildAssistantFailoverSignal } from "../embedded-agent-helpers/assistant-message-failures.js";
import { formatUserFacingAssistantErrorText } from "../embedded-agent-helpers/error-text.js";
import { classifyProviderRuntimeFailureKind } from "../embedded-agent-helpers/provider-runtime-failure.js";
import { isNonProviderRuntimeCoordinationError } from "../failover-error.js";
import { makeAssistantMessageFixture as makeAssistant } from "../test-helpers/assistant-message-fixtures.js";
import {
  ERROR_DETAILS_HINT,
  renderAssistantRequestFailureCopy,
  renderRecordedAssistantFailureCopy,
  renderRuntimeCoordinationFailureCopy,
  renderStorageFailureSummary,
} from "./assistant-request-failure-copy.js";
import { isAuthErrorMessage } from "./message-patterns.js";

describe("renderAssistantRequestFailureCopy", () => {
  const target = { provider: "openai", model: "test-model" };
  const runFailure =
    "⚠️ OpenClaw couldn't finish this reply. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.";
  const live = (fields: Parameters<typeof makeAssistant>[0]) =>
    formatUserFacingAssistantErrorText(makeAssistant(fields));
  const loading = (fields: Parameters<typeof makeAssistant>[0]) =>
    makeAssistant({
      errorCode: "model_load_failed",
      errorMessage: "PRIVATE_DETAIL",
      errorBody: '{"requestedContextLength":49152}',
      ...fields,
    });
  function expectBoth(expected: string, fields: Parameters<typeof makeAssistant>[0]) {
    const assistant = makeAssistant(fields);
    expect(formatUserFacingAssistantErrorText(assistant)).toBe(expected);
    expect(renderRecordedAssistantFailureCopy(assistant)).toBe(expected);
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
      ...target,
      errorMessage: "Session actor requires reconciliation before another command",
    });
    const copy = formatUserFacingAssistantErrorText(assistant);
    expect(copy).toContain("reopen the conversation");
    expect(copy).toContain("restart OpenClaw");
    expect(copy).not.toContain("Session actor");
    expect(renderRecordedAssistantFailureCopy(assistant)).toBe(copy);
  });

  it.each([
    ["operator cancellation", "canceling statement due to user request PRIVATE_STORAGE_DETAIL"],
    ["statement timeout", "canceling statement due to statement timeout PRIVATE_STORAGE_DETAIL"],
  ])("retains %s guidance in live replies and saved history", (_scenario, message) => {
    const error = decodePostgresError({ name: "error", message, code: "57014" });
    const storageFailure = classifyGatewayStorageFailure(error);
    expect(storageFailure).toBe("57014");
    const assistant = makeAssistant({
      errorMessage: error.message,
      errorCode: storageFailure,
      errorType: error.name,
    });
    expect(classifyGatewayStorageFailure(assistant)).toBe("57014");
    expect(classifyProviderRuntimeFailureKind(buildAssistantFailoverSignal(assistant))).toBe(
      "gateway_storage",
    );
    const summary = renderStorageFailureSummary(storageFailure);
    expect(summary).toEqual(expect.any(String));
    expect(summary).not.toBe("");
    for (const copy of [
      formatUserFacingAssistantErrorText(assistant),
      renderRecordedAssistantFailureCopy(assistant),
    ]) {
      expect(copy).toContain(summary);
      expect(copy).toContain(ERROR_DETAILS_HINT);
      expect(copy).not.toContain("PRIVATE_STORAGE_DETAIL");
    }
  });

  it("retains cancellation provenance through name-only actor errors", () => {
    const error = decodePostgresError({
      name: "error",
      message: "canceling statement due to user request PRIVATE_ACTOR_DETAIL",
      code: "57014",
    });
    const actorError = { name: error.name, message: error.message };
    expect(classifyGatewayStorageFailure(actorError)).toBe("57014");
    const assistant = makeAssistant({
      errorMessage: actorError.message,
      errorType: actorError.name,
    });
    expect(classifyGatewayStorageFailure(assistant)).toBe("57014");
    for (const copy of [
      formatUserFacingAssistantErrorText(assistant),
      renderRecordedAssistantFailureCopy(assistant),
    ]) {
      expect(copy).toContain(ERROR_DETAILS_HINT);
      expect(copy).not.toContain("PRIVATE_ACTOR_DETAIL");
    }
  });

  it("keeps provider-owned 57014 errors out of storage cancellation handling", () => {
    const assistant = makeAssistant({
      errorCode: "57014",
      errorType: "rate_limit_error",
      errorMessage: "Rate limit reached PRIVATE_PROVIDER_DETAIL",
    });
    const signal = buildAssistantFailoverSignal(assistant);
    expect(classifyGatewayStorageFailure(assistant)).toBeUndefined();
    expect(classifyGatewayStorageFailure(signal)).toBeUndefined();
    expect(classifyProviderRuntimeFailureKind(signal)).toBe("rate_limit");
    expect(renderRecordedAssistantFailureCopy(assistant)).toBe(
      renderAssistantRequestFailureCopy({ reason: "rate_limit" }),
    );
    for (const copy of [
      formatUserFacingAssistantErrorText(assistant),
      renderRecordedAssistantFailureCopy(assistant),
    ]) {
      expect(copy).toEqual(expect.any(String));
      expect(copy).not.toBe("");
      expect(copy).not.toMatch(/postgres/i);
      expect(copy).not.toContain("PRIVATE_PROVIDER_DETAIL");
    }
  });

  it("renders loading facts consistently in live replies and saved history without provider prose", () => {
    const expected = String.raw`Could not load model "local\/model" with 49152 context tokens. Wait for loading to finish on the model server, then retry, or lower the model's configured context size.`;
    const assistant = loading({
      model: "local/model",
      errorMessage: "PRIVATE_PROVIDER_DETAIL",
      errorBody: JSON.stringify({
        requestedContextLength: 49152,
        message: "PRIVATE_PROVIDER_DETAIL",
        nextStep: "PRIVATE_INJECTION",
      }),
    });
    expect(formatUserFacingAssistantErrorText(assistant)).toBe(expected);
    expect(renderRecordedAssistantFailureCopy(assistant)).toBe(expected);
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
    const expected =
      "This model endpoint does not support reasoning_effort. Set compat.supportsReasoningEffort: false on this model in your custom provider configuration and try again.";
    expectBoth(expected, {
      provider: "custom-local",
      model: "reasoning-model",
      errorMessage: `400 ${JSON.stringify({ error: { type: "invalid_request_error", message: detail } })}`,
    });
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
    const expected = String.raw`bge\-m3\:latest is an embedding model and cannot chat; pick a chat model with /model (or remove it from models.providers.ollama.models).`;
    expectBoth(expected, {
      provider: "ollama",
      model: "bge-m3:latest",
      errorMessage: "400 " + errorBody,
      errorBody,
    });
  });

  it.each([
    JSON.stringify({
      error: {
        type: "invalid_request_error",
        message: JSON.stringify({ input: "PRIVATE_PROMPT" }),
      },
    }),
    '422 Unprocessable Entity: [{"input":"PRIVATE_PROMPT"',
  ])("keeps private payloads out of live and saved replies: %s", (errorMessage) => {
    const assistant = makeAssistant({ errorMessage });
    expect(formatUserFacingAssistantErrorText(assistant)).not.toContain("PRIVATE");
    expect(renderRecordedAssistantFailureCopy(assistant)).not.toContain("PRIVATE");
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
    "422 Unprocessable Content: <html>PRIVATE_PROMPT</html>",
    '400 Bad Request: [{"input":"PRIVATE_PROMPT"}]',
    '422 Unprocessable Entity: [{"input":"PRIVATE_PROMPT"',
  ])("does not display a status-prefixed raw response body: %s", (errorMessage) => {
    const assistant = makeAssistant({ ...target, errorMessage });
    expect(formatUserFacingAssistantErrorText(assistant)).not.toContain("PRIVATE");
    expect(renderRecordedAssistantFailureCopy(assistant)).not.toContain("PRIVATE");
  });

  it("keeps provider bodies containing SQLite text redacted", () => {
    const errorMessage = '{"error":{"message":"database is locked PRIVATE_CANARY"}}';
    expect(live({ errorMessage })).toBe(runFailure);
  });

  it("handles partial model context", () => {
    expect(renderAssistantRequestFailureCopy({ model: "test-model" })).toBe(runFailure);
  });

  it("requires a valid HTTP status before asserting a request failure", () => {
    expect(renderAssistantRequestFailureCopy({ ...target, status: 0 })).toBe(runFailure);
    expect(renderAssistantRequestFailureCopy({ ...target, status: 400 })).toBe(runFailure);
  });
});
