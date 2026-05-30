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
    providerRuntimeMocks.classifyProviderPluginError.mockImplementation((context) => {
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
        provider: "other-provider",
        status: 403,
        code: "PROVIDER_QUOTA_EXHAUSTED",
        message: "Forbidden",
      }),
    ).toEqual({ kind: "reason", reason: "auth" });
  });

  it("passes nested provider error types through failover error normalization", () => {
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
});
