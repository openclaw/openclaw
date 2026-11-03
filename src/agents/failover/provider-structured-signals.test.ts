import { beforeEach, describe, expect, it, vi } from "vitest";
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
  function expectReason(reason: string, signal: Parameters<typeof classifyFailoverSignal>[0]) {
    expect(classifyFailoverSignal(signal)).toEqual({ kind: "reason", reason });
  }
  const refusal = (errorType: string, errorCode: string, errorMessage: string) =>
    makeMessage({ provider: "custom-route", errorType, errorCode, errorMessage });
  function expectSafeCopy(fields: Fields, expected: string) {
    const message = makeMessage({ errorMessage: privateDetail, ...fields });
    const text = userCopy(message);
    expect(text).toBe(expected);
    expect(text).not.toMatch(/RAW_BODY_CANARY|Authorization|secret-canary|private\.invalid/);
    expect(hook).not.toHaveBeenCalled();
    return message;
  }
  const rejection = (message: string) =>
    `400 ${JSON.stringify({ error: { type: "invalid_request_error", message } })}`;

  beforeEach(() => {
    hook.mockReset();
  });

  it("gives prepared context policy precedence without rediscovery", () => {
    expect(
      userCopy(refusal("PROVIDER_TYPE", "unknown_parameter", "403 fixture refusal"), {
        providerOwner: {
          id: "prepared-owner",
          matchesContextOverflowError: () => true,
          classifyFailoverReason: () => {
            throw new Error("Context policy must take precedence");
          },
        },
      }),
    ).toBe(contextCopy);
    expect(hook).not.toHaveBeenCalled();
  });

  it.each([
    [
      {
        errorMessage: "This request was blocked by our safety systems.",
        errorCode: "misalignment_policy_violation",
        errorType: "invalid_request_error",
        errorBody: '{"misalignment":{"detailed_explanation":"PRIVATE_FINDINGS ... [truncated]',
      },
      "The provider stopped this request as a safety precaution (misalignment).",
    ],
    [
      {
        errorMessage: rejection("provider refusal"),
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
        errorMessage: rejection("max_tokens (100) exceeds maximum output tokens (50)"),
        errorBody: '{"error":{"message":"insufficient credits"}}',
      },
      formatBillingErrorMessage(),
    ],
    [
      { errorBody: '{"error":{"message":"Request size exceeds model context window"}}' },
      contextCopy,
    ],
    [
      { errorCode: "DEACTIVATED_WORKSPACE" },
      "⚠️ The AI service isn't accepting your login. Sign in again under Models in the Control UI or run `openclaw configure`.",
    ],
    [{ errorBody: '{"error":{"type":"upstream_error"}}' }, serverCopy],
    [{ errorMessage: undefined, errorType: "upstream_error" }, serverCopy, true],
  ] satisfies [Fields, string, boolean?][])(
    "presents structured %j without discovery",
    (fields, expected, checkDiagnostic?: boolean) => {
      const message = expectSafeCopy(fields, expected);
      if (checkDiagnostic) {
        expect(formatAssistantErrorText(message)).toBe(expected);
      }
    },
  );

  it("uses provider-attributed inferred auth statuses only for scoped hook consultation", () => {
    for (const [status, message] of [
      [403, "403 concurrency limit breached"],
      [429, "429 API key budget limit exceeded"],
    ] as const) {
      hook.mockImplementation(({ provider, context }) =>
        provider === "demo-provider" && context.status === status ? "billing" : undefined,
      );
      expectReason("billing", { provider: "demo-provider", message });
    }
  });

  it("passes nested provider error types through failover error normalization", () => {
    hook.mockImplementation(({ context }) =>
      context.provider === "demo-provider" && context.errorType === "PROVIDER_QUOTA_EXHAUSTED"
        ? "billing"
        : undefined,
    );

    expect(
      resolveReason({
        provider: "demo-provider",
        status: 403,
        type: "error",
        error: { type: "PROVIDER_QUOTA_EXHAUSTED", message: "Forbidden" },
      }),
    ).toBe("billing");
  });

  it("classifies replay-invalid carriers as terminal format failures", () => {
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
    hook.mockImplementation(({ context }) =>
      context.provider === "anthropic" && context.errorType === errorType
        ? "rate_limit"
        : undefined,
    );

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
    hook.mockImplementation(({ context }) =>
      context.errorType === undefined ? "billing" : undefined,
    );

    const message = "unclassified provider failure";
    for (const fields of [{ type: "api_error" }, { detail: { type: "api_error" } }]) {
      expect(resolveReason({ provider: "demo-provider", message, ...fields })).toBe("billing");
    }
  });

  it("routes a preserved server_error code to server_error instead of timeout (#117609)", () => {
    hook.mockImplementation(({ context }) =>
      context.provider === "openai" && context.code === "server_error" ? "server_error" : undefined,
    );

    const signal = { provider: "openai", message: "server_error: provider failed" };
    expectReason("timeout", signal);
    expect(hook).not.toHaveBeenCalled();

    expectReason("server_error", { ...signal, code: "server_error" });
  });
});
