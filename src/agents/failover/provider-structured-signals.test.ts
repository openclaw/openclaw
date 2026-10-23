import { beforeEach, describe, expect, it, vi } from "vitest";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../../shared/assistant-error-format.js";
import { buildApiErrorObservationFields } from "../embedded-agent-error-observation.js";
import { classifyAssistantFailoverReason as assistantReason } from "../embedded-agent-helpers/assistant-message-failures.js";
import {
  formatAssistantErrorText,
  formatUserFacingAssistantErrorText as userCopy,
} from "../embedded-agent-helpers/error-text.js";
import { classifyProviderRuntimeFailureKind as runtimeKind } from "../embedded-agent-helpers/provider-runtime-failure.js";
import { resolveFailoverReasonFromError as resolveReason } from "../failover-error.js";
import { makeAssistantMessageFixture as makeMessage } from "../test-helpers/assistant-message-fixtures.js";
import { PROVIDER_SCHEMA_REJECTION_USER_TEXT } from "./assistant-request-failure-copy.js";
import { classifyFailoverSignal } from "./classify.js";
import { formatBillingErrorMessage } from "./user-copy.js";

const providerRuntimeMocks = vi.hoisted(() => ({
  classifyProviderFailoverSignalWithPlugin: vi.fn(),
}));

vi.mock("../../plugins/provider-failover.js", () => providerRuntimeMocks);

describe("provider failover hook structured signals", () => {
  type Fields = Parameters<typeof makeMessage>[0];
  const hook = providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin;
  const rateLimitCopy = "⚠️ The AI service needs a short break. Please try again in a few minutes.";
  const serverCopy = "⚠️ The AI service is having trouble. Please try again in a moment.";
  const contextCopy =
    "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.";
  const privateDetail =
    "RAW_BODY_CANARY Authorization: Bearer secret-canary https://private.invalid/body";
  const signalContext = {
    provider: "prepared-owner",
    status: 403,
    code: "unknown_parameter",
    errorType: "PROVIDER_TYPE",
  };
  function expectReason(reason: string, signal: Parameters<typeof classifyFailoverSignal>[0]) {
    expect(classifyFailoverSignal(signal)).toEqual({ kind: "reason", reason });
  }
  const hookCall = (errorMessage: string, status?: number) => ({
    provider: "demo-provider",
    context: {
      provider: "demo-provider",
      status,
      code: undefined,
      errorType: undefined,
      errorMessage,
    },
  });
  const refusal = (errorType: string, errorCode: string, errorMessage: string) =>
    makeMessage({ provider: "custom-route", errorType, errorCode, errorMessage });

  beforeEach(() => {
    hook.mockReset();
  });

  it("explains a saved misalignment code without newer refusal diagnostics", () => {
    const message = makeMessage({
      errorMessage: "This request was blocked by our safety systems.",
      errorCode: "misalignment_policy_violation",
      errorType: "invalid_request_error",
      errorBody: '{"misalignment":{"detailed_explanation":"PRIVATE_FINDINGS ... [truncated]',
    });
    expect(userCopy(message)).toBe(
      "The provider stopped this request as a safety precaution (misalignment).",
    );
  });

  it.each([
    [
      MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
      "LLM streaming response contained a malformed fragment. Please try again.",
      "unclassified",
    ],
    [
      "model input limit reached",
      "⚠️ OpenClaw couldn't finish this reply. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.",
      "unclassified",
    ],
    [
      '429 {"error":{"type":"rate_limit_error","message":"Too many requests"}}',
      rateLimitCopy,
      "rate_limit",
    ],
  ])("presents/observes %s without discovery", (errorMessage, copy, expectedKind) => {
    const message = makeMessage({ errorMessage });
    expect(userCopy(message)).toBe(copy);
    expect.soft(hook).not.toHaveBeenCalled();
    hook.mockClear();
    expect(
      buildApiErrorObservationFields(errorMessage, { provider: message.provider }),
    ).toMatchObject({
      providerRuntimeFailureKind: expectedKind,
      rawErrorHash: expect.stringMatching(/^sha256:/),
    });
    expect(hook).not.toHaveBeenCalled();
  });

  it.each(["billing", "rate_limit", "context_overflow", "model_not_found", "format"] as const)(
    "uses prepared %s policy without rediscovery",
    (reason) => {
      const classifyFailoverReason = vi.fn(() => reason);
      const matchesContextOverflowError = vi.fn(() => reason === "context_overflow");
      const message = refusal("PROVIDER_TYPE", "unknown_parameter", "403 fixture refusal");
      const copies = {
        billing: formatBillingErrorMessage("custom-route", message.model),
        rate_limit: rateLimitCopy,
        context_overflow: contextCopy,
        model_not_found: "This model was not found. Choose another model in the Control UI.",
        format: "LLM request rejected: fixture refusal",
      };
      expect(
        userCopy(message, {
          provider: "custom-route",
          providerOwner: {
            id: "prepared-owner",
            matchesContextOverflowError,
            classifyFailoverReason,
          },
        }),
      ).toBe(copies[reason]);
      expect(matchesContextOverflowError).toHaveBeenCalledWith({
        ...signalContext,
        errorMessage: message.errorMessage,
      });
      if (reason === "context_overflow") {
        expect(classifyFailoverReason).not.toHaveBeenCalled();
      } else {
        expect(classifyFailoverReason).toHaveBeenCalledWith(expect.objectContaining(signalContext));
      }
      expect(hook).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ errorCode: "RESOURCE_EXHAUSTED" }, rateLimitCopy],
    [
      {
        errorMessage: '400 {"error":{"type":"invalid_request_error","message":"provider refusal"}}',
        errorCode: "RESOURCE_EXHAUSTED",
      },
      rateLimitCopy,
    ],
    [
      { errorMessage: undefined, errorType: "invalid_request_error" },
      PROVIDER_SCHEMA_REJECTION_USER_TEXT,
    ],
    [
      {
        errorMessage:
          '400 {"error":{"type":"invalid_request_error","message":"max_tokens (100) exceeds maximum output tokens (50)"}}',
        errorBody: '{"error":{"message":"insufficient credits"}}',
      },
      formatBillingErrorMessage(),
    ],
    [
      { errorBody: '{"error":{"message":"Request size exceeds model context window"}}' },
      contextCopy,
    ],
  ] satisfies [Fields, string][])("presents structured %j without discovery", (fields, copy) => {
    const message = makeMessage({ errorMessage: "provider refusal", ...fields });
    expect(userCopy(message)).toBe(copy);
    expect(hook).not.toHaveBeenCalled();
  });

  it.each([
    [
      {
        errorCode: "DEACTIVATED_WORKSPACE",
      },
      "⚠️ The AI service isn't accepting your login. Sign in again under Models in the Control UI or run `openclaw configure`.",
    ],
    [{ errorBody: '{"error":{"type":"upstream_error"}}' }, serverCopy],
    [{ errorMessage: undefined, errorType: "upstream_error" }, serverCopy],
  ] satisfies [Fields, string][])("sanitizes structured %j", (fields, expected) => {
    const message = makeMessage({ errorMessage: privateDetail, ...fields });
    const text = userCopy(message);
    expect(text).toBe(expected);
    if ("errorMessage" in fields && fields.errorMessage === undefined) {
      expect(formatAssistantErrorText(message)).toBe(expected);
    }
    expect(text).not.toMatch(/RAW_BODY_CANARY|Authorization|secret-canary|private\.invalid/);
    expect(hook).not.toHaveBeenCalled();
  });

  it("carries a prepared owner's structured decision into safe composed copy", () => {
    const classifyFailoverReason = vi.fn(
      ({ code, errorType }: { code?: string; errorType?: string }) =>
        code === "OWNER_CODE" && errorType === "OWNER_TYPE" ? ("server_error" as const) : undefined,
    );
    const message = refusal("OWNER_TYPE", "OWNER_CODE", `403 ${privateDetail}`);
    const text = userCopy(message, {
      providerOwner: { id: "prepared-owner", classifyFailoverReason },
    });
    expect(text).toBe(serverCopy);
    expect(text).not.toMatch(/RAW_BODY_CANARY|Authorization|secret-canary|private\.invalid/);
    expect(classifyFailoverReason).toHaveBeenCalledWith(
      expect.objectContaining({ ...signalContext, code: "OWNER_CODE", errorType: "OWNER_TYPE" }),
    );
    expect(hook).not.toHaveBeenCalled();
  });

  it("uses provider-attributed inferred auth statuses only for scoped hook consultation", () => {
    hook.mockImplementation(({ provider, context }) =>
      provider === "demo-provider" && (context.status === 403 || context.status === 429)
        ? "billing"
        : undefined,
    );

    expectReason("billing", {
      provider: "demo-provider",
      message: "403 concurrency limit breached",
    });
    expect(hook).toHaveBeenCalledWith(hookCall("403 concurrency limit breached", 403));
    expectReason("billing", {
      provider: "demo-provider",
      message: "429 API key budget limit exceeded",
    });
    expect(hook).toHaveBeenLastCalledWith(hookCall("429 API key budget limit exceeded", 429));
  });

  it("passes nested provider error types through failover error normalization", () => {
    hook.mockImplementation(({ context }) => {
      return context.provider === "demo-provider" &&
        context.errorType === "PROVIDER_QUOTA_EXHAUSTED"
        ? "billing"
        : undefined;
    });

    expect(
      resolveReason({
        provider: "demo-provider",
        status: 403,
        type: "error",
        error: {
          type: "PROVIDER_QUOTA_EXHAUSTED",
          message: "Forbidden",
        },
      }),
    ).toBe("billing");
  });

  it("classifies replay-invalid carriers as terminal format failures", () => {
    hook.mockReturnValue(undefined);
    const carriers = [
      '{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.1: Invalid `signature` in `thinking` block"}}',
      'Validation error: The model returned the following errors: {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.1: Invalid `signature` in `thinking` block"}}',
    ];

    for (const errorMessage of carriers) {
      expectReason("format", { provider: "anthropic", message: errorMessage });
      const message = makeMessage({ provider: "anthropic", errorMessage });
      expect(assistantReason(message)).toBe("format");
      expect(runtimeKind(errorMessage)).toBe("replay_invalid");
    }
  });

  it("classifies message-less Anthropic rate-limit assistant failures", () => {
    const errorType = "rate_limit_error";
    hook.mockImplementation(({ context }) => {
      if (context.provider !== "anthropic") {
        return undefined;
      }
      if (context.errorType === "rate_limit_error") {
        return "rate_limit";
      }
      return context.errorType === "api_error" ? "server_error" : undefined;
    });

    const message = makeMessage({
      provider: "anthropic",
      errorMessage: undefined,
      errorType,
      content: [],
    });

    expect(assistantReason(message)).toBe("rate_limit");
    const signal = { provider: "anthropic", message: "", errorType };
    expect(runtimeKind(signal)).toBe("rate_limit");
    expect(runtimeKind(signal, { providerPlugin: null })).toBe("unclassified");
  });

  it("consults message-only hooks without promoting generic SDK type strings", () => {
    hook.mockReturnValue("billing");

    const message = "unclassified provider failure";
    for (const fields of [{ type: "api_error" }, { detail: { type: "api_error" } }]) {
      expect(resolveReason({ provider: "demo-provider", message, ...fields })).toBe("billing");
    }
    expect(hook).toHaveBeenCalledTimes(2);
    for (const [call] of hook.mock.calls) {
      expect(call).toEqual(hookCall(message));
    }
  });

  it("routes a preserved server_error code to server_error instead of timeout (#117609)", () => {
    // Preserved structured codes must outrank the timeout prose classifier.
    hook.mockImplementation(({ context }) =>
      context.provider === "openai" && context.code === "server_error" ? "server_error" : undefined,
    );

    const signal = { provider: "openai", message: "server_error: provider failed" };
    expectReason("timeout", signal);
    expect(hook).not.toHaveBeenCalled();

    expectReason("server_error", { ...signal, code: "server_error" });
    expect(hook).toHaveBeenCalledTimes(1);
  });
});
