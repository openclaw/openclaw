// Covers provider hook structured failover signals.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFailoverReasonFromError } from "../failover-error.js";
import { classifyFailoverSignal } from "./errors.js";

const providerRuntimeMocks = vi.hoisted(() => ({
  classifyProviderPluginError: vi.fn(),
}));

vi.mock("./provider-error-patterns.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider-error-patterns.js")>();
  return {
    ...actual,
    classifyProviderPluginError: providerRuntimeMocks.classifyProviderPluginError,
  };
});

describe("provider failover hook structured signals", () => {
  beforeEach(() => {
    providerRuntimeMocks.classifyProviderPluginError.mockReset();
  });

  it("lets provider hooks refine ambiguous auth statuses from stable codes", () => {
    // HTTP 403 is ambiguous; provider-owned stable codes can refine it to
    // billing or rate-limit without weakening default auth handling.
    providerRuntimeMocks.classifyProviderPluginError.mockImplementation((context) => {
      if (
        context.provider === "demo-provider" &&
        context.status === 403 &&
        context.code === "PROVIDER_RATE_LIMITED"
      ) {
        return "rate_limit";
      }
      return context.provider === "demo-provider" &&
        context.status === 403 &&
        context.code === "PROVIDER_QUOTA_EXHAUSTED"
        ? "billing"
        : undefined;
    });

    expect(
      classifyFailoverSignal({
        provider: "demo-provider",
        status: 403,
        code: "PROVIDER_QUOTA_EXHAUSTED",
        message: "Forbidden",
      }),
    ).toEqual({ kind: "reason", reason: "billing" });
    expect(
      classifyFailoverSignal({
        provider: "demo-provider",
        status: 403,
        code: "PROVIDER_RATE_LIMITED",
        message: "Forbidden",
      }),
    ).toEqual({ kind: "reason", reason: "rate_limit" });
    expect(
      classifyFailoverSignal({
        provider: "other-provider",
        status: 403,
        code: "PROVIDER_QUOTA_EXHAUSTED",
        message: "Forbidden",
      }),
    ).toEqual({ kind: "reason", reason: "auth" });
  });

  it("does not call the direct provider hook for unstructured classified messages", () => {
    // Plain message classifiers run first; provider hooks only see structured
    // descriptors where a plugin can make a reliable decision.
    expect(
      classifyFailoverSignal({
        provider: "demo-provider",
        message: "invalid_api_key",
      }),
    ).toEqual({ kind: "reason", reason: "auth" });
    expect(providerRuntimeMocks.classifyProviderPluginError).not.toHaveBeenCalled();
  });

  it("does not treat message-parsed HTTP prefixes as structured provider descriptors", () => {
    providerRuntimeMocks.classifyProviderPluginError.mockReturnValue("billing");

    expect(
      classifyFailoverSignal({
        provider: "demo-provider",
        message: "403 concurrency limit breached",
      }),
    ).toEqual({ kind: "reason", reason: "auth" });
    expect(providerRuntimeMocks.classifyProviderPluginError).not.toHaveBeenCalled();
  });

  it("passes nested provider error types through failover error normalization", () => {
    // SDK wrappers often put the provider code under error.type; normalization
    // should preserve that code for provider hooks.
    providerRuntimeMocks.classifyProviderPluginError.mockImplementation((context) => {
      return context.provider === "demo-provider" &&
        context.errorType === "PROVIDER_QUOTA_EXHAUSTED"
        ? "billing"
        : undefined;
    });

    expect(
      resolveFailoverReasonFromError({
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

  it("does not promote generic SDK type strings as structured provider descriptors", () => {
    providerRuntimeMocks.classifyProviderPluginError.mockReturnValue("billing");

    expect(
      resolveFailoverReasonFromError({
        provider: "demo-provider",
        type: "api_error",
        message: "unclassified provider failure",
      }),
    ).toBeNull();
    expect(
      resolveFailoverReasonFromError({
        provider: "demo-provider",
        message: "unclassified provider failure",
        detail: { type: "api_error" },
      }),
    ).toBeNull();
    expect(providerRuntimeMocks.classifyProviderPluginError).not.toHaveBeenCalled();
  });

  it("classifies upstream_error errorType as server_error for model fallback", () => {
    // When a provider returns an upstream_error type (e.g. OpenAI-compatible
    // providers wrapping transient backend failures), the error should be
    // classified as server_error so that configured fallback models are tried.
    expect(
      classifyFailoverSignal({
        provider: "openai",
        errorType: "upstream_error",
        message: "Upstream request failed",
      }),
    ).toEqual({ kind: "reason", reason: "server_error" });
  });

  it("does not override provider plugin classification for upstream_error", () => {
    // If a provider plugin hook already classifies the error, the
    // errorType-based fallback should not interfere.
    providerRuntimeMocks.classifyProviderPluginError.mockReturnValue("overloaded");

    expect(
      classifyFailoverSignal({
        provider: "demo-provider",
        errorType: "upstream_error",
        message: "Upstream request failed",
      }),
    ).toEqual({ kind: "reason", reason: "overloaded" });
  });
});
