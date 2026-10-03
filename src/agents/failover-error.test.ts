import { describe, expect, it, vi } from "vitest";
import { createAgentRunStaleLifecycleError } from "../infra/agent-lifecycle-error.js";
import { diagnosticErrorFailureKind } from "../infra/diagnostic-error-metadata.js";
import { attachErrorDiagnostic, formatErrorMessageForDisplay } from "../infra/error-diagnostics.js";
import { formatErrorMessage } from "../infra/errors.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import {
  buildFailoverRemediationHint,
  buildProviderReauthCommand,
  coerceToFailoverError,
  describeFailoverError,
  FailoverError,
  findCliTimeoutError,
  hasProviderRequestSizeCeiling,
  isNonProviderRuntimeCoordinationError,
  isSignalTimeoutReason,
  isTimeoutError,
  resolveFailoverReasonFromError,
  resolveModelFallbackError,
} from "./failover-error.js";
import { isLikelyContextOverflowError } from "./failover/classify.js";
import { getFailoverErrorCode } from "./failover/error.js";
import type { FailoverReason } from "./failover/signal.js";
import { AgentHarnessPreflightError } from "./harness/errors.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";

// These fixtures exercise core classification without cold-loading provider runtimes.
vi.mock("../plugins/provider-hook-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/provider-hook-runtime.js")>();
  return {
    ...actual,
    resolveProviderHookPlugin: () => undefined,
    resolveProviderPluginsForHooks: () => [],
  };
});

function expectReason(error: unknown, reason: FailoverReason | null) {
  expect(resolveFailoverReasonFromError(error)).toBe(reason);
}

describe("failover-error", () => {
  it("preserves an Ollama model-retirement error instead of coercing it to a timeout", () => {
    const body = JSON.stringify({
      error: "glm-5.1 was retired at 2026-09-25 00:00:00 -0700 PDT (ref: synthetic-retirement)",
    });
    const error = Object.assign(new Error(`410 ${body}`), { status: 410, body });
    expect(coerceToFailoverError(error, { provider: "ollama" })).toMatchObject({
      reason: "model_not_found",
      status: 410,
      rawError: error.message,
    });
  });

  it("does not promote a direct preflight into a provider failure", () => {
    const message = "handoff refused: 529 OVERLOADED";
    const cause = { status: 529, code: "OVERLOADED", message: "overloaded" };
    const error = new AgentHarnessPreflightError(message, { cause });
    expectReason(error, null);
    expect(coerceToFailoverError(error)).toBeNull();
    expect(describeFailoverError(error)).toEqual({ message });
    expect(resolveModelFallbackError(error)).toEqual({ kind: "coordination", error });
    expect(error.cause).toBe(cause);
  });

  it("finds structured CLI timeout context through aggregate wrappers", () => {
    const timeout = new FailoverError("CLI exceeded timeout", {
      reason: "timeout",
      code: "cli_overall_timeout",
      cliTimeout: {
        mode: "overall",
        timeoutSeconds: 600,
        observedActivity: true,
        activeToolCount: 0,
        backgroundTaskCount: 1,
      },
    });
    expect(findCliTimeoutError(new AggregateError([{ cause: timeout }], "CLI turn failed"))).toBe(
      timeout,
    );
  });

  it("infers failover reason from HTTP status", () => {
    const noBody = { message: "HTTP 422: No response body" };
    const parameterError = { status: 422, message: "check open ai req parameter error" };
    const unprocessable = { message: "Unprocessable Entity" };
    const missingProperty = { message: "missing required property" };
    expectReason({ status: 402 }, "billing");
    expectReason(
      {
        status: 402,
        message: "HTTP 402: request reached organization usage limit, try again later",
      },
      "rate_limit",
    );
    expectReason(
      { status: 402, message: "insufficient credits — please top up your account" },
      "billing",
    );
    expectReason({ statusCode: "+429" }, "rate_limit");
    expectReason({ statusCode: "0x1ad" }, null);
    expectReason({ status: 403 }, "auth");
    expectReason({ status: 408 }, "timeout");
    expectReason({ status: 410 }, "timeout");
    expectReason({ status: 499 }, "timeout");
    expectReason({ status: 400 }, null);
    expectReason({ status: 422 }, null);
    expectReason({ status: 400, message: "400 status code (no body)" }, null);
    expectReason({ status: 422, message: "Error: HTTP 422: No response body" }, null);
    expectReason({ message: "400 status code (no body)" }, null);
    expectReason({ message: "HTTP 422: No body" }, null);
    expectReason({ message: "outer wrapper", cause: { status: 422, ...noBody } }, null);
    expectReason({ ...parameterError, cause: { status: 422, ...noBody } }, null);
    expectReason({ ...parameterError, cause: new Error("No response body") }, null);
    expectReason({ status: 422, ...unprocessable, error: noBody }, null);
    expectReason(
      {
        status: 422,
        ...unprocessable,
        cause: { ...unprocessable, error: noBody },
      },
      null,
    );
    expectReason({ status: 422, error: missingProperty, cause: {} }, "format");
    expectReason({ status: 422, error: missingProperty, cause: noBody }, "format");
    for (const status of [504, 522, 524]) {
      expectReason({ status }, "timeout");
    }
    expectReason({ status: 500 }, "server_error");
    expectReason({ status: 529 }, "overloaded");
  });

  it("classifies certificate failures separately from timeouts", () => {
    expectReason(
      {
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
        message: "Hostname/IP does not match certificate's altnames",
      },
      "tls_certificate",
    );
    expectReason(
      new TypeError("fetch failed", {
        cause: { code: "CERT_HAS_EXPIRED", message: "certificate has expired" },
      }),
      "tls_certificate",
    );
    expectReason(
      { status: 400, code: "CERT_HAS_EXPIRED", message: "certificate field rejected" },
      "format",
    );
  });

  it("stops on cyclic cause chains", () => {
    const first: { cause?: unknown } = {};
    first.cause = { cause: first };
    expectReason(first, null);
  });

  it("treats session-specific HTTP 410s differently from generic 410s", () => {
    expectReason({ status: 410, message: "session not found" }, "session_expired");
    expectReason({ message: "HTTP 410: No body" }, "timeout");
    expectReason({ message: "HTTP 410: conversation expired" }, "session_expired");
  });

  it("lets an overloaded payload override timeout-shaped HTTP 499", () => {
    expectReason(
      {
        status: 499,
        message: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      },
      "overloaded",
    );
  });

  it("lets provider-attributed billing evidence refine ambiguous HTTP 429", () => {
    const message =
      '{"error":{"type":"rate_limit_reached","message":"Insufficient account balance. Please recharge your Moonshot account."}}';
    expectReason({ provider: "moonshot", status: 429, message }, "billing");
    expect(resolveFailoverReasonFromError({ status: 429, message }, "kimi-claw")).toBe("billing");
    expectReason(
      { provider: "moonshot", status: 429, message: "Rate limit reached for requests per min." },
      "rate_limit",
    );
    expectReason({ provider: "openai", status: 429, message }, "rate_limit");
  });

  it("classifies the bare shared model runtime stream wrapper as timeout (#71620)", () => {
    expectReason({ message: "An unknown error occurred" }, "timeout");
  });

  it("treats structured quota failures as billing instead of generic HTTP policy", () => {
    const message =
      '{"type":"error","error":{"type":"insufficient_quota","message":"Your account has insufficient quota balance to run this request."}}';
    expectReason({ status: 400, message }, "billing");
    expectReason({ provider: "openai", status: 429, message }, "billing");
    expectReason(
      {
        provider: "openai",
        status: 429,
        message: '{"error":"insufficient_balance","message":"Insufficient account balance"}',
      },
      "billing",
    );
    expectReason(
      {
        provider: "openai",
        status: 429,
        message:
          'HTTP 429: {"error":"insufficient_balance","message":"Insufficient account balance"}',
      },
      "billing",
    );
    expectReason(
      { provider: "openai", status: 429, message: "This model requires more credits to use" },
      "billing",
    );
  });

  it("classifies structured HTTP 400 context overflow payloads without using format", () => {
    expectReason(
      { status: 400, message: "INVALID_ARGUMENT: input exceeds the maximum number of tokens" },
      "context_overflow",
    );
  });

  it("uses structured OpenAI-compatible param detail for model-not-found 400s", () => {
    const err = Object.assign(new Error("400 Param Incorrect"), {
      status: 400,
      code: "400",
      param: "Not supported model some-model-id",
      error: {
        code: "400",
        message: "Param Incorrect",
        param: "Not supported model some-model-id",
      },
    });
    expectReason(err, "model_not_found");
    expect(describeFailoverError(err)).toMatchObject({
      message: "400 Param Incorrect",
      reason: "model_not_found",
      status: 400,
      code: "400",
    });
  });

  it.each([
    { message: "openrouter/__invalid_test_model__ is not a valid model ID" },
    { status: 400, message: "HTTP 400: openrouter/__invalid_test_model__ is not a valid model ID" },
    { status: 422, message: "invalid model: openrouter/__invalid_test_model__" },
  ])("classifies invalid-model payloads as model_not_found: $message", (error) => {
    expectReason(error, "model_not_found");
  });

  it.each([
    ["402", "Monthly spend limit reached. Please visit your billing settings.", "rate_limit"],
    ["HTTP 402", "rate limit exceeded", "rate_limit"],
    ["HTTP 402", "Your usage limit has been reached. Please upgrade your plan.", "billing"],
  ] as const)(
    "keeps %s wrappers aligned with status-split payloads: %s",
    (prefix, message, reason) => {
      expectReason({ message: `${prefix} Payment Required: ${message}` }, reason);
      expectReason({ status: 402, message }, reason);
    },
  );

  it("infers timeout from node network codes and failover-specific codes", () => {
    expectReason({ code: "ETIMEDOUT" }, "timeout");
    expectReason({ code: "EHOSTDOWN" }, "timeout");
  });

  it("infers rate-limit and overload from symbolic error codes", () => {
    expectReason({ code: "RESOURCE_EXHAUSTED" }, "rate_limit");
    expectReason({ code: "OVERLOADED_ERROR" }, "overloaded");
  });

  it("treats AbortError reason=abort as timeout", () => {
    const err = Object.assign(new Error("aborted"), {
      name: "AbortError",
      reason: "reason: abort",
    });
    expect(isTimeoutError(err)).toBe(true);
  });

  it("classifies abort-wrapped RESOURCE_EXHAUSTED as rate_limit", () => {
    const err = Object.assign(new Error("request aborted"), {
      name: "AbortError",
      cause: {
        error: {
          code: 429,
          message: "RESOURCE_EXHAUSTED: Resource has been exhausted (e.g. check quota).",
          status: "RESOURCE_EXHAUSTED",
        },
      },
    });
    expectReason(err, "rate_limit");
    expect(coerceToFailoverError(err)).toMatchObject({ reason: "rate_limit", status: 429 });
  });

  it("lets wrapped causes override parent context-overflow classifications", () => {
    const err = new Error("INVALID_ARGUMENT: input exceeds the maximum number of tokens", {
      cause: { code: "RESOURCE_EXHAUSTED" },
    });
    expectReason(err, "rate_limit");
    expect(coerceToFailoverError(err)?.reason).toBe("rate_limit");
  });

  it("preserves typed failure facts and diagnostics when adding the active auth mode", () => {
    const cause = Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
    const facts = {
      reason: "timeout",
      provider: "anthropic",
      model: "sonnet-4.6",
      profileId: "anthropic:default",
      status: 408,
      rawError: "408 upstream deadline exceeded",
      authProfileFailure: { allInCooldown: false },
      sessionId: "diagnostic-session",
      lane: "answer",
      cause,
      suspend: false,
      cliTimeout: {
        mode: "no-output",
        timeoutSeconds: 30,
        observedActivity: true,
        activeToolCount: 1,
        backgroundTaskCount: 0,
      },
      timeout: { timeoutPhase: "provider" },
      attempts: [{ provider: "anthropic", model: "sonnet-4.6", reason: "timeout" }],
      soonestCooldownExpiry: null,
    } satisfies ConstructorParameters<typeof FailoverError>[1];
    const original = new FailoverError("request timed out", facts);
    attachErrorDiagnostic(original, "stderr: Rate limit exceeded during an earlier request");
    const err = coerceToFailoverError(original, { authMode: "token" });
    expect(err).not.toBe(original);
    expect(err).toMatchObject({ ...facts, authMode: "token" });
    expect(err?.cause).toBe(cause);
    expect(err?.message).toBe("request timed out");
    expect(describeFailoverError(err).rawError).toBe(facts.rawError);
    expect(getFailoverErrorCode(err)).toBeUndefined();
    expect(findCliTimeoutError(err)).toBe(err);
    expect(err?.requestSizeCeiling).toBe(false);
    expect(formatErrorMessageForDisplay(err)).toContain(
      "Rate limit exceeded during an earlier request",
    );
    expect(original.authMode).toBeUndefined();
  });

  it("adds a recorded timeout without replacing attribution", () => {
    const original = new FailoverError("provider failed", { reason: "timeout", authMode: "oauth" });
    const timeout = {};
    const error = coerceToFailoverError(original, { timeout, authMode: "token" });
    expect(error).toMatchObject({ timeout, authMode: "oauth" });
    expect(error?.timeout).toBe(timeout);
    expect(original.timeout).toBeUndefined();
    expect(coerceToFailoverError(error, { timeout: { timeoutPhase: "preflight" } })).toBe(error);
    expect(
      coerceToFailoverError({ status: 500, message: "upstream failed" }, { timeout })?.timeout,
    ).toBe(timeout);
  });

  it("coerces JSON-wrapped OpenRouter stealth-model 404s into FailoverError", () => {
    const err = coerceToFailoverError(
      '{"error":{"message":"Healer Alpha was a stealth model revealed on March 18th as an early testing version of MiMo-V2-Omni. Find it here: https://openrouter.ai/xiaomi/mimo-v2-omni","code":404},"user_id":"synthetic"}',
      {
        provider: "openrouter",
        model: "openrouter/healer-alpha",
      },
    );
    expect(err).toMatchObject({ reason: "model_not_found", status: 404 });
  });

  it("coerces format errors with a 400 status", () => {
    expect(
      coerceToFailoverError("invalid request format", {
        provider: "google",
        model: "cloud-code-assist",
      }),
    ).toMatchObject({ reason: "format", status: 400 });
  });

  it("403 with revoked key message returns auth_permanent", () => {
    expectReason({ status: 403, message: "api key revoked" }, "auth_permanent");
  });

  it("Codex deactivated workspace marker returns auth_permanent", () => {
    expectReason({ code: "deactivated_workspace" }, "auth_permanent");
    expectReason({ detail: { code: "deactivated_workspace" } }, "auth_permanent");
    expectReason(
      { status: 403, message: "Forbidden", detail: { code: "deactivated_workspace" } },
      "auth_permanent",
    );
    expectReason(
      { status: 400, message: "Bad request", detail: { code: "deactivated_workspace" } },
      "auth_permanent",
    );
  });

  it("classifies OpenAI-compatible server_error payloads at the error boundary", () => {
    const err = coerceToFailoverError(
      {
        status: 500,
        message:
          'Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request."},"sequence_number":2}',
      },
      { provider: "openai", model: "gpt-5.4" },
    );
    expect(err).toMatchObject({ reason: "server_error", status: 500 });
  });

  it("coerceToFailoverError carries sessionId/lane from context (#42713)", () => {
    const err = coerceToFailoverError("rate limit exceeded", {
      provider: "openai",
      model: "gpt-5",
      profileId: "p1",
      sessionId: "session:browser-1234",
      lane: "draft",
    });
    expect(err).toMatchObject({
      sessionId: "session:browser-1234",
      lane: "draft",
      provider: "openai",
    });
  });

  it("describes non-Error values consistently", () => {
    const described = describeFailoverError(123);
    expect(described.message).toBe("123");
    expect(described.reason).toBeUndefined();
  });
});

describe("failover diagnostic isolation", () => {
  it.each(["raw", "serialized"] as const)(
    "normalizes local-profile HTTP status from a %s error without changing its owner",
    (shape) => {
      const message =
        'Codex app-server auth profile "openai:default" was not found. Select an existing OpenAI profile or sign in again with OpenClaw, then retry.';
      const cause = new Error("profile store lookup missed");
      const context = {
        provider: "openai",
        model: "gpt-5.5",
        profileId: "openai:default",
        authMode: "oauth",
        sessionId: "session:local-profile",
        lane: "main",
      };
      const facts = {
        ...context,
        reason: "auth" as const,
        status: 401,
        code: "selected_auth_profile_unavailable",
        rawError: message,
        cause,
      };
      const original = Object.freeze(
        shape === "serialized"
          ? { ...facts, name: "FailoverError", message }
          : Object.assign(new Error(message, { cause }), facts),
      );
      expect(describeFailoverError(original)).toMatchObject({
        message,
        code: facts.code,
        status: undefined,
      });
      const normalized = coerceToFailoverError(original, shape === "raw" ? context : undefined);
      expect(normalized).toMatchObject({
        ...facts,
        status: undefined,
        cause: shape === "raw" ? original : cause,
      });
      expect(normalized?.message).toBe(message);
      expect(buildFailoverRemediationHint(normalized)).toBeUndefined();
      expect(original.status).toBe(401);
      expect(original.message).toBe(message);
    },
  );

  it("retains a genuine provider HTTP 401 and its recovery hint", () => {
    const original = Object.freeze(Object.assign(new Error("invalid_api_key"), { status: 401 }));
    const normalized = coerceToFailoverError(original, { provider: "openai" });
    expect(describeFailoverError(original).status).toBe(401);
    expect(normalized).toMatchObject({ reason: "auth", status: 401, cause: original });
    expect(buildFailoverRemediationHint(normalized)).toBe(
      "Re-authenticate with: openclaw models auth login --provider 'openai' --force",
    );
  });

  it("keeps supplemental process diagnostics out of failure policy", () => {
    const diagnostic =
      "413 Request too large on tokens per minute (TPM): Limit 8000, Requested 8098";
    const native = Object.freeze(new Error("Claude Code process exited with code 1"));
    const error = attachErrorDiagnostic(native, diagnostic);
    expect(error).toBe(native);
    expect(formatErrorMessageForDisplay(error)).toContain(diagnostic);
    for (const candidate of [error, new Error("Plugin execution failed", { cause: error })]) {
      expect(coerceToFailoverError(candidate)).toBeNull();
      expect(isTimeoutError(candidate)).toBe(false);
      expect(diagnosticErrorFailureKind(candidate)).toBeUndefined();
      expect(hasProviderRequestSizeCeiling(candidate)).toBe(false);
      expect(isLikelyContextOverflowError(formatErrorMessage(candidate))).toBe(false);
      expect(formatErrorMessage(candidate)).not.toContain(diagnostic);
    }
    expect(
      hasProviderRequestSizeCeiling(new AggregateError([{ error }], "Plugin execution failed")),
    ).toBe(false);
  });
});

describe("buildFailoverRemediationHint", () => {
  it("routes Gemini CLI auth failures to supported recovery paths", () => {
    const err = new FailoverError("revoked", {
      reason: "auth_permanent",
      provider: "google-gemini-cli",
    });
    expect(buildFailoverRemediationHint(err)).toBe(
      "Authenticate in Gemini CLI directly, or configure a supported Google API key with: openclaw configure",
    );
  });

  it("quotes provider ids that contain shell metacharacters", () => {
    expect(buildProviderReauthCommand("custom;touch /tmp/pwned")).toBe(
      "openclaw models auth login --provider 'custom;touch /tmp/pwned' --force",
    );
    expect(buildProviderReauthCommand("custom'provider")).toBe(
      "openclaw models auth login --provider 'custom'\\''provider' --force",
    );
  });

  it("refuses control characters in rendered provider commands", () => {
    expect(buildProviderReauthCommand("custom\nprovider")).toBeUndefined();
  });

  it("returns undefined for non-auth reasons", () => {
    expect(
      buildFailoverRemediationHint(
        new FailoverError("429", { reason: "rate_limit", provider: "openai" }),
      ),
    ).toBeUndefined();
  });

  it("returns undefined when provider is not attributed", () => {
    expect(
      buildFailoverRemediationHint(new FailoverError("no token", { reason: "auth" })),
    ).toBeUndefined();
  });
});

describe("isNonProviderRuntimeCoordinationError", () => {
  it("returns true for stale gateway lifecycle ownership loss", () => {
    const staleLifecycle = createAgentRunStaleLifecycleError();
    expect(isNonProviderRuntimeCoordinationError(staleLifecycle)).toBe(true);
    expect(
      isNonProviderRuntimeCoordinationError(new Error("wrapper", { cause: staleLifecycle })),
    ).toBe(true);
  });

  it.each([
    "WorkerRunnerUnavailableError",
    "NodeRunnerUpdateRequiredError",
    "CodexNodeExecServerDisconnectedError",
  ])("returns true for direct and nested %s coordination failures", (name) => {
    const coordination = Object.assign(new Error("private coordination diagnostic"), { name });
    for (const error of [coordination, new Error("worker turn failed", { cause: coordination })]) {
      expect(isNonProviderRuntimeCoordinationError(error)).toBe(true);
      expect(resolveModelFallbackError(error)).toEqual({ kind: "coordination", error });
    }
  });

  it("does not read a SQLite worker code as a provider overload", () => {
    const error = new SqliteWorkerError("SQLite worker store capacity reached", "overloaded");
    for (const candidate of [error, new Error("lane task error", { cause: error })]) {
      expect(resolveModelFallbackError(candidate)).toEqual({
        kind: "coordination",
        error: candidate,
      });
      expect(coerceToFailoverError(candidate)).toBeNull();
      expect(describeFailoverError(candidate).reason).toBeUndefined();
    }
  });

  it("treats superseded prepared runtime publication as coordination (#156975)", () => {
    const error = new PreparedModelRuntimePublicationSupersededError(
      "prepared model runtime publication was superseded for /tmp/agent",
    );
    for (const candidate of [error, new Error("lane task error", { cause: error })]) {
      expect(isNonProviderRuntimeCoordinationError(candidate)).toBe(true);
      expect(resolveModelFallbackError(candidate)).toEqual({
        kind: "coordination",
        error: candidate,
      });
      expect(coerceToFailoverError(candidate)).toBeNull();
      expectReason(candidate, null);
      expect(describeFailoverError(candidate).reason).toBeUndefined();
    }
  });

  it("returns true for Codex missing tool-result local execution failures", () => {
    expect(isNonProviderRuntimeCoordinationError({ reason: "missing_tool_result" })).toBe(true);
    expect(
      isNonProviderRuntimeCoordinationError({
        message: "codex app-server turn failed",
        cause: { result: { reason: "missing_tool_result" } },
      }),
    ).toBe(true);
    expectReason(
      new Error(
        "OpenClaw recorded a native Codex tool.call without a matching tool.result before the turn completed.",
      ),
      null,
    );
  });

  it("returns false for plain timeouts and provider errors", () => {
    expect(
      isNonProviderRuntimeCoordinationError(
        Object.assign(new Error("operation timed out"), { name: "TimeoutError" }),
      ),
    ).toBe(false);
    expect(
      isNonProviderRuntimeCoordinationError({
        status: 503,
        message: "upstream overloaded",
        cause: { result: { reason: "missing_tool_result" } },
      }),
    ).toBe(false);
    expect(
      isNonProviderRuntimeCoordinationError({
        status: 503,
        message: "upstream overloaded",
        cause: createAgentRunStaleLifecycleError(),
      }),
    ).toBe(false);
    expect(isNonProviderRuntimeCoordinationError(null)).toBe(false);
  });
});

it("does not treat an AbortError matching transport timeout wording as a signal timeout", () => {
  const err = Object.assign(new Error("request aborted"), { name: "AbortError" });
  expect(isSignalTimeoutReason(err)).toBe(false);
});

describe("hasProviderRequestSizeCeiling", () => {
  it("finds the recorded ceiling through nested error and aggregate wrappers", () => {
    const ceiling = new FailoverError("Context overflow: prompt too large for the model.", {
      reason: "context_overflow",
      rawError: "413 Request too large on tokens per minute (TPM): Limit 8000, Requested 8098",
    });
    expect(
      hasProviderRequestSizeCeiling(
        new AggregateError(
          [new Error("unrelated"), { error: { cause: ceiling } }],
          "agent run failed",
        ),
      ),
    ).toBe(true);
  });

  it("is false for throttling that states a requested size within the limit", () => {
    const throttled =
      "429 Rate limit reached on tokens per minute (TPM): Limit 8000, Used 7500, Requested 1000, please try again in 3.5s.";
    expect(hasProviderRequestSizeCeiling(new Error(throttled))).toBe(false);
    expect(
      new FailoverError("rate limited", { reason: "rate_limit", rawError: throttled })
        .requestSizeCeiling,
    ).toBe(false);
  });
});
