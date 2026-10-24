import { expect, it, onTestFinished } from "vitest";
import { configureExecutionDecisionWorkSink } from "../audit/execution-decision-work.js";
import type { ExecutionDecisionWork } from "../audit/execution-decision-work.types.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "./admitted-run-context.js";
import { recordAdmittedModelRoutingDecision } from "./model-routing-decision.js";

const route = {
  requestedProvider: "openai",
  requestedModel: "gpt-5.6",
  selectedProvider: "openai",
  selectedModel: "gpt-5.6",
  selectionMode: "automatic",
} as const;

function captureWork() {
  const captured: ExecutionDecisionWork[] = [];
  const restore = configureExecutionDecisionWorkSink((work) => {
    captured.push(work);
    return true;
  });
  onTestFinished(restore);
  return captured;
}

function prepareRoutingAdmission(runId: string) {
  return prepareAgentRunAdmission({
    cfg: { logging: { audit: { executionIdentity: true } } },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "model-routing-test", state: "present" },
    },
  });
}

it("keeps a selected credential raw only in the private work ref", async () => {
  const captured = captureWork();
  const admission = prepareRoutingAdmission("model-route-run");
  const admittedRunContext = await admission.admit("embedded");
  const rawProfile = "openai:user@example.test";
  const rawTargetSecret = "Authorization: Bearer selected-model-secret";

  expect(
    recordAdmittedModelRoutingDecision({
      ...route,
      admittedRunContext,
      selectedModel: rawTargetSecret,
      selectionMode: "explicit",
      credentialProfileId: rawProfile,
      fallbackReason: "rate_limit",
      occurredAt: 1_001,
    }),
  ).toBe(true);
  admission.close();

  expect(captured).toMatchObject([
    {
      token: admittedRunContext.executionIdentityToken,
      receipt: {
        action: { family: "model-routing", operation: "explicit-selection" },
        decision: { reasonCode: "rate_limit" },
        enforcement: { coverageState: "attribution-only" },
      },
      refs: {
        resource: { namespace: "credential-profile", value: rawProfile },
        target: { namespace: "model-route" },
      },
    },
  ]);
  expect(JSON.stringify(captured[0]?.receipt)).not.toContain(rawProfile);
  expect(JSON.stringify(captured[0]?.receipt)).not.toContain("selected-model-secret");
  expect(captured[0]?.refs?.target?.value).toContain(rawTargetSecret);
});

it("does not fabricate work without admission and marks an unknown credential owner", async () => {
  const captured = captureWork();

  expect(recordAdmittedModelRoutingDecision(route)).toBe(false);
  const admission = prepareRoutingAdmission("unknown-owner-run");
  const admittedRunContext = await admission.admit("embedded");
  expect(recordAdmittedModelRoutingDecision({ ...route, admittedRunContext })).toBe(true);
  admission.close();

  expect(captured).toHaveLength(1);
  expect(captured[0]?.receipt).toMatchObject({
    enforcement: { coverageState: "unknown" },
    missingEvidence: ["credential_profile_owner"],
  });
  expect(captured[0]?.refs?.resource).toBeUndefined();
});

it.each(["close", "replace"] as const)(
  "rejects %s authority without queuing private work",
  async (loss) => {
    const runId = `model-route-${loss}`;
    const admission = prepareRoutingAdmission(runId);
    const admittedRunContext = await admission.admit("embedded");
    const replacement = loss === "replace" ? prepareRoutingAdmission(runId) : undefined;
    if (replacement) {
      await replacement.admit("embedded");
    } else {
      admission.close();
    }
    const captured = captureWork();

    expect(() => recordAdmittedModelRoutingDecision({ ...route, admittedRunContext })).toThrow(
      "admitted run authority is no longer active",
    );
    admission.close();
    replacement?.close();

    expect(captured).toEqual([]);
  },
);
