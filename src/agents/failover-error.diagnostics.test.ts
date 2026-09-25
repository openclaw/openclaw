import { describe, expect, it, vi } from "vitest";
import { createAgentRunStaleLifecycleError } from "../infra/agent-lifecycle-error.js";
import { diagnosticErrorFailureKind } from "../infra/diagnostic-error-metadata.js";
import { attachErrorDiagnostic, formatErrorMessageForDisplay } from "../infra/error-diagnostics.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  buildFailoverRemediationHint,
  coerceToFailoverError,
  describeFailoverError,
  FailoverError,
  hasProviderRequestSizeCeiling,
  isNonProviderRuntimeCoordinationError,
  isTimeoutError,
  resolveFailoverReasonFromError,
  resolveModelFallbackError,
} from "./failover-error.js";
import { isLikelyContextOverflowError } from "./failover/classify.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
} from "./prepared-model-runtime.errors.js";

// Provider hooks do not classify these native process-exit fixtures.
vi.mock("../plugins/provider-hook-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/provider-hook-runtime.js")>();
  return {
    ...actual,
    resolveProviderHookPlugin: () => undefined,
    resolveProviderPluginsForHooks: () => [],
  };
});

describe("failover diagnostic isolation", () => {
  it.each(["raw", "typed", "serialized"] as const)(
    "normalizes published local-profile HTTP status from a %s error without changing its owner",
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
          : shape === "typed"
            ? new FailoverError(message, facts)
            : Object.assign(new Error(message, { cause }), facts),
      );
      if (original instanceof Error) {
        attachErrorDiagnostic(original, "profile owner: OpenClaw credential store");
      }

      expect.soft(describeFailoverError(original)).toMatchObject({
        message,
        code: facts.code,
        status: undefined,
      });
      const normalized = coerceToFailoverError(original, shape === "raw" ? context : undefined);
      expect.soft(normalized).toMatchObject({
        ...facts,
        status: undefined,
        cause: shape === "raw" ? original : cause,
      });
      expect(normalized?.message).toBe(message);
      expect(buildFailoverRemediationHint(normalized)).toBeUndefined();
      expect(original.status).toBe(401);
      expect(original.message).toBe(message);
      if (shape === "typed") {
        expect(formatErrorMessageForDisplay(normalized)).toContain("profile owner: OpenClaw");
      }
    },
  );

  it("retains a genuine provider HTTP 401 and its recovery hint", () => {
    const original = Object.freeze(Object.assign(new Error("invalid_api_key"), { status: 401 }));
    const normalized = coerceToFailoverError(original, { provider: "openai" });

    expect(describeFailoverError(original).status).toBe(401);
    expect(normalized).toMatchObject({ reason: "auth", status: 401, cause: original });
    expect(buildFailoverRemediationHint(normalized)).toContain("Re-authenticate with:");
  });

  it.each([
    "Rate limit exceeded",
    "Authentication failed: invalid_api_key",
    "Request timed out; operation was aborted",
    "INVALID_ARGUMENT: input exceeds the maximum number of tokens",
    "413 Request too large on tokens per minute (TPM): Limit 8000, Requested 8098",
  ])("keeps supplemental process diagnostics out of failure policy: %s", (diagnostic) => {
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

describe("failover-error", () => {
  describe("isNonProviderRuntimeCoordinationError", () => {
    it("returns true for stale gateway lifecycle ownership loss", () => {
      const staleLifecycle = createAgentRunStaleLifecycleError();
      expect(isNonProviderRuntimeCoordinationError(staleLifecycle)).toBe(true);
      expect(
        isNonProviderRuntimeCoordinationError(new Error("wrapper", { cause: staleLifecycle })),
      ).toBe(true);
    });

    it.each([
      ["availability", "WorkerRunnerUnavailableError", "The device runner is offline"],
      ["capacity", "WorkerRunnerCapacityError", "device worker capacity remained full"],
      [
        "workspace reconciliation",
        "WorkerWorkspaceReconciliationError",
        "cloud worker workspace result could not be reconciled",
      ],
      ["active turn claim", "ActiveTurnClaimError", "session already has an active turn claim"],
    ])("returns true for direct and nested runner %s failures", (_label, name, message) => {
      const coordination = new Error(message);
      coordination.name = name;
      for (const error of [
        coordination,
        new Error("worker turn failed", { cause: coordination }),
      ]) {
        expect(isNonProviderRuntimeCoordinationError(error)).toBe(true);
        expect(resolveModelFallbackError(error)).toEqual({ kind: "coordination", error });
      }
    });

    it.each([
      [
        "publication superseded",
        () =>
          new PreparedModelRuntimePublicationSupersededError(
            "prepared model runtime publication was superseded for /tmp/agent",
          ),
      ],
      [
        "owner not published",
        () =>
          new PreparedModelRuntimeOwnerNotPublishedError(
            "prepared model runtime owner is not published for /tmp/agent",
          ),
      ],
    ])(
      "treats prepared model runtime %s as coordination, not a provider quota failure",
      (_label, make) => {
        const error = make();
        const wrapped = new Error("lane task error", { cause: error });
        for (const candidate of [error, wrapped]) {
          expect(isNonProviderRuntimeCoordinationError(candidate)).toBe(true);
          expect(resolveModelFallbackError(candidate)).toEqual({
            kind: "coordination",
            error: candidate,
          });
          expect(coerceToFailoverError(candidate)).toBeNull();
          expect(resolveFailoverReasonFromError(candidate)).toBeNull();
          expect(describeFailoverError(candidate).reason).toBeUndefined();
        }
      },
    );

    it("returns true for Codex missing tool-result local execution failures", () => {
      const missingToolResultMessage =
        "OpenClaw recorded a native Codex tool.call without a matching tool.result before the turn completed.";
      expect(isNonProviderRuntimeCoordinationError({ reason: "missing_tool_result" })).toBe(true);
      expect(
        isNonProviderRuntimeCoordinationError({
          message: "codex app-server turn failed",
          cause: { result: { reason: "missing_tool_result" } },
        }),
      ).toBe(true);
      expect(resolveFailoverReasonFromError(new Error(missingToolResultMessage))).toBeNull();
    });

    it("returns false for plain timeouts and provider errors", () => {
      const timeoutErr = Object.assign(new Error("operation timed out"), { name: "TimeoutError" });
      expect(isNonProviderRuntimeCoordinationError(timeoutErr)).toBe(false);
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
      expect(isNonProviderRuntimeCoordinationError(undefined)).toBe(false);
    });

    it("does not suppress provider fallback for unrelated free text mentioning the marker", () => {
      expect(isNonProviderRuntimeCoordinationError("reason=missing_tool_result")).toBe(false);
    });
  });
});
