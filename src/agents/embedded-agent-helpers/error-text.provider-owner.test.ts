import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveReplyFailureSummary } from "../../auto-reply/reply/agent-runner-failure-reply.js";
import { classifyProviderFailoverSignalWithPlugin } from "../../plugins/provider-failover.js";
import { buildApiErrorObservationFields } from "../embedded-agent-error-observation.js";
import { coerceToFailoverError, FailoverError } from "../failover-error.js";
import { classifyFailoverSignal } from "../failover/classify.js";
import { isContextOverflowError } from "../failover/context-overflow.js";
import { resolveReplyFailoverFacts } from "../failover/request-error-facts.js";
import { formatBillingErrorMessage } from "../failover/user-copy.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { classifyAssistantFailoverReason } from "./assistant-message-failures.js";
import {
  classifyAssistantErrorFacts,
  formatAssistantErrorText,
  formatUserFacingAssistantErrorText,
} from "./error-text.js";
import { classifyProviderRuntimeFailureKind } from "./provider-runtime-failure.js";

vi.mock("../../plugins/provider-failover.js", () => ({
  classifyProviderFailoverSignalWithPlugin: vi.fn(),
}));

describe("assistant diagnostic provider ownership", () => {
  beforeEach(() => {
    vi.mocked(classifyProviderFailoverSignalWithPlugin)
      .mockReset()
      .mockReturnValue("model_not_found");
  });

  it("prepares one billing reply across assistant and exception shapes", () => {
    const billingError = { message: "Choose a plan.", actionUrl: "https://example.com/plans" };
    const isPlanRefusal = ({ errorMessage }: { errorMessage: string }) =>
      errorMessage.includes(billingError.message);
    const formatBillingError = vi.fn((context: { errorMessage: string }) =>
      isPlanRefusal(context) ? billingError : undefined,
    );
    const providerOwner = {
      id: "prepared-owner",
      classifyFailoverReason: (context: { errorMessage: string }) =>
        isPlanRefusal(context) ? ("billing" as const) : undefined,
      formatBillingError,
    };
    const attribution = { provider: "custom-route", model: "model-a" };
    const context = { ...attribution, authMode: "oauth", providerOwner };
    const assistant = makeAssistantMessageFixture({
      ...attribution,
      errorMessage: billingError.message,
    });
    const facts = classifyAssistantErrorFacts(assistant, context);
    expect(facts).toMatchObject({ reason: "billing", billingError });
    expect(formatAssistantErrorText(assistant, context, facts)).toBe(billingError.message);
    expect(formatUserFacingAssistantErrorText(assistant, context, facts)).toBe(
      billingError.message,
    );
    expect(formatBillingError).toHaveBeenCalledOnce();
    const cause = new Error(billingError.message);
    const thrown = Object.assign(new Error(billingError.message), { status: 403 });
    const typed = { ...attribution, reason: "billing" as const, status: 403, cause };
    const inputs = {
      thrown,
      wrapped: new Error("request failed", { cause: thrown }),
      inherited: Object.assign(new Error("request failed", { cause }), { status: 403 }),
      typed: new FailoverError("request failed", typed),
      guided: new FailoverError("request failed", { ...typed, billingError }),
    };
    let failure: FailoverError | null = null;
    for (const [shape, input] of Object.entries(inputs)) {
      formatBillingError.mockClear();
      failure = coerceToFailoverError(input, context);
      expect(failure, shape).toMatchObject({
        ...attribution,
        reason: "billing",
        billingError,
        status: 403,
      });
      const calls = formatBillingError.mock.calls.length;
      expect(calls === 0).toBe(shape === "guided");
      if (calls) {
        expect(formatBillingError).toHaveBeenLastCalledWith(
          expect.objectContaining({ provider: "prepared-owner", status: 403 }),
        );
      }
    }
    assert.instanceOf(failure, FailoverError);
    expect(
      resolveReplyFailureSummary({
        error: failure,
        message: failure.message,
        facts: resolveReplyFailoverFacts(failure, failure.message),
      }),
    ).toEqual({ kind: "billing", text: billingError.message });
    expect(classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
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

  it("records diagnostics and classifies unowned exceptions without provider discovery", () => {
    const failure = coerceToFailoverError(
      { status: 403, message: "Forbidden", cause: new Error("insufficient credits") },
      { provider: "custom-route", providerOwner: null },
    );
    expect(failure?.reason).toBe("auth");
    expect(failure?.billingError).toBeUndefined();
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
    expect(coerceToFailoverError(new Error("opaque runtime failure"))?.reason).toBe(
      "model_not_found",
    );
    vi.mocked(classifyProviderFailoverSignalWithPlugin).mockReturnValue("context_overflow");
    expect(isContextOverflowError("prompt reached the tenant maximum")).toBe(true);
    expect(classifyProviderFailoverSignalWithPlugin).toHaveBeenCalledTimes(4);
  });
});
