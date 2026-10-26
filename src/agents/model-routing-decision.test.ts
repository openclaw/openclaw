import { expect, it, onTestFinished } from "vitest";
import { configureExecutionDecisionWorkSink } from "../audit/execution-decision-work.js";
import type { ExecutionDecisionWork } from "../audit/execution-decision-work.types.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
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

async function admitRoute(runId: string) {
  const admission = prepareSystemAgentRunAdmission(
    { logging: { audit: { executionIdentity: true } } },
    runId,
    "main",
    "model-routing-test",
  );
  onTestFinished(() => admission.close());
  return { admission, admittedRunContext: await admission.admit("embedded") };
}

it("keeps a selected credential raw only in the private work ref", async () => {
  const captured = captureWork();
  const { admittedRunContext } = await admitRoute("model-route-run");
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
  expect(captured).toHaveLength(1);
  const { token, receipt, refs } = captured[0]!;
  expect(token).toBe(admittedRunContext.executionIdentityToken);
  expect(receipt).toMatchObject({
    action: { family: "model-routing", operation: "explicit-selection" },
    decision: { reasonCode: "rate_limit" },
    enforcement: { coverageState: "attribution-only" },
  });
  expect(refs?.resource).toEqual({ namespace: "credential-profile", value: rawProfile });
  expect(refs?.target).toMatchObject({ namespace: "model-route" });
  expect(JSON.stringify(receipt)).not.toContain(rawProfile);
  expect(JSON.stringify(receipt)).not.toContain("selected-model-secret");
  expect(refs?.target?.value).toContain(rawTargetSecret);
});

it("does not fabricate work without admission and marks an unknown credential owner", async () => {
  const captured = captureWork();

  expect(recordAdmittedModelRoutingDecision(route)).toBe(false);
  const { admittedRunContext } = await admitRoute("unknown-owner-run");
  expect(recordAdmittedModelRoutingDecision({ ...route, admittedRunContext })).toBe(true);
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
    const { admission, admittedRunContext } = await admitRoute(runId);
    if (loss === "replace") {
      await admitRoute(runId);
    } else {
      admission.close();
    }
    const captured = captureWork();

    expect(() => recordAdmittedModelRoutingDecision({ ...route, admittedRunContext })).toThrow(
      "admitted run authority is no longer active",
    );
    admission.close();

    expect(captured).toEqual([]);
  },
);
