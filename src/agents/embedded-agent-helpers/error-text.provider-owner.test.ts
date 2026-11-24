import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyProviderFailoverSignalWithPlugin } from "../../plugins/provider-failover.js";
import { buildApiErrorObservationFields } from "../embedded-agent-error-observation.js";
import { coerceToFailoverError, FailoverError } from "../failover-error.js";
import { classifyFailoverSignal } from "../failover/classify.js";
import { isContextOverflowError } from "../failover/context-overflow.js";
import { formatBillingErrorMessage } from "../failover/user-copy.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { classifyAssistantFailoverReason } from "./assistant-message-failures.js";
import { formatAssistantErrorText, formatUserFacingAssistantErrorText } from "./error-text.js";
import { classifyProviderRuntimeFailureKind } from "./provider-runtime-failure.js";

vi.mock("../../plugins/provider-failover.js", () => ({
  classifyProviderFailoverSignalWithPlugin: vi.fn(),
}));

describe("assistant diagnostic provider ownership", () => {
  it.each([undefined, { message: "Choose an active plan." }])(
    "retains a typed failure's billing fact without calling the provider again: %j",
    (billingError) => {
      const formatBillingError = vi.fn(() => ({ message: "Replacement copy" }));
      const failure = new FailoverError("Payment required", { reason: "billing", billingError });
      const enriched = coerceToFailoverError(failure, {
        authMode: "oauth",
        providerOwner: { id: "fixture", formatBillingError },
      });
      expect(enriched?.billingError).toBe(billingError);
      expect(formatBillingError).not.toHaveBeenCalled();
    },
  );

  beforeEach(() => {
    vi.mocked(classifyProviderFailoverSignalWithPlugin)
      .mockReset()
      .mockReturnValue("model_not_found");
  });

  it.each(["provider sent an opaque failure", "prompt reached the tenant maximum"])(
    "renders %j without discovering provider policy",
    (errorMessage) => {
      expect(formatAssistantErrorText(makeAssistantMessageFixture({ errorMessage }))).toBe(
        errorMessage,
      );
      expect(classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
    },
  );

  it("uses explicit billing copy even when it equals the raw error, without discovery", () => {
    const message = "Payment required. Choose an active plan for third-party apps.";
    const assistant = makeAssistantMessageFixture({ errorMessage: message });
    const providerOwner = {
      id: "synthetic-owner",
      classifyFailoverReason: () => "billing" as const,
      formatBillingError: () => ({ message, actionUrl: "https://example.com/plans" }),
    };
    expect(formatAssistantErrorText(assistant, { providerOwner })).toBe(message);
    expect(formatUserFacingAssistantErrorText(assistant, { providerOwner })).toBe(message);
    expect(classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    () => undefined,
    () => ({ message: "  " }),
    () => {
      throw new Error("private provider diagnostic");
    },
  ])(
    "keeps generic billing copy when the hook supplies no usable guidance %#",
    (formatBillingError) => {
      const assistant = makeAssistantMessageFixture({
        errorMessage: "403 Payment required RAW_BILLING_CANARY",
      });
      expect(
        formatUserFacingAssistantErrorText(assistant, {
          provider: "fixture",
          model: "sample",
          providerOwner: { id: "fixture", formatBillingError },
        }),
      ).toBe(formatBillingErrorMessage("fixture", "sample"));
      expect(classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
    },
  );

  it("keeps the prepared owner through schema diagnostics", () => {
    const classifyFailoverReason = vi.fn(() => "format" as const);
    expect(
      formatAssistantErrorText(
        makeAssistantMessageFixture({ errorMessage: "provider rejected this payload" }),
        { providerOwner: { id: "synthetic-owner", classifyFailoverReason } },
      ),
    ).toBe("LLM request rejected: provider rejected this payload");
    expect(
      buildApiErrorObservationFields("provider rejected this payload", {
        provider: "custom-route",
        providerOwner: { id: "synthetic-owner", classifyFailoverReason },
      }),
    ).toMatchObject({ providerRuntimeFailureKind: "schema" });
    expect(classifyFailoverReason).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "synthetic-owner" }),
    );
    expect(classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
  });

  it("keeps the prepared owner through context diagnostics", () => {
    expect(
      formatAssistantErrorText(
        makeAssistantMessageFixture({ errorMessage: "prompt reached the tenant maximum" }),
        {
          providerOwner: {
            id: "synthetic-owner",
            matchesContextOverflowError: () => true,
          },
        },
      ),
    ).toContain("Context overflow: prompt too large for the model.");
    expect(classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
  });

  it("records diagnostics without discovering provider policy", () => {
    expect(
      classifyAssistantFailoverReason(
        makeAssistantMessageFixture({ errorMessage: "provider sent an opaque failure" }),
        { providerOwner: null },
      ),
    ).toBeNull();
    expect(
      buildApiErrorObservationFields("provider sent an opaque failure", { provider: "openai" }),
    ).toMatchObject({ providerRuntimeFailureKind: "unclassified" });
    expect(classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
  });

  it("preserves runtime discovery when no prepared owner is supplied", () => {
    expect(
      classifyFailoverSignal({ provider: "synthetic-owner", message: "opaque runtime failure" }),
    ).toEqual({ kind: "reason", reason: "model_not_found" });
    expect(classifyProviderRuntimeFailureKind("opaque runtime failure")).toBe("model_not_found");
    vi.mocked(classifyProviderFailoverSignalWithPlugin).mockReturnValue("context_overflow");
    expect(isContextOverflowError("prompt reached the tenant maximum")).toBe(true);
    expect(classifyProviderFailoverSignalWithPlugin).toHaveBeenCalledTimes(3);
  });
});
