import { beforeEach, expect, it, onTestFinished } from "vitest";
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
const auditConfig = { logging: { audit: { executionIdentity: true } } };
type Route = Partial<Parameters<typeof recordAdmittedModelRoutingDecision>[0]>;
let captured: ExecutionDecisionWork[];

beforeEach(() => {
  captured = [];
  onTestFinished(
    configureExecutionDecisionWorkSink((work) => {
      captured.push(work);
      return true;
    }),
  );
});

async function admitRoute(runId: string) {
  const admission = prepareSystemAgentRunAdmission(auditConfig, runId, "main", "test");
  onTestFinished(() => admission.close());
  const admittedRunContext = await admission.admit("embedded");
  const record = (overrides: Route = {}) =>
    recordAdmittedModelRoutingDecision({ ...route, admittedRunContext, ...overrides });
  return { admission, admittedRunContext, record };
}

it("keeps a selected credential raw only in the private work ref", async () => {
  const { admittedRunContext, record } = await admitRoute("model-route-run");
  const rawProfile = "openai:user@example.test";
  const rawTargetSecret = "Authorization: Bearer selected-model-secret";

  expect(
    record({
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
  expect(recordAdmittedModelRoutingDecision(route)).toBe(false);
  const { record } = await admitRoute("unknown-owner-run");
  expect(record()).toBe(true);
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
    const { admission, record } = await admitRoute(runId);
    if (loss === "replace") {
      await admitRoute(runId);
    } else {
      admission.close();
    }
    expect(() => record()).toThrow("admitted run authority is no longer active");
    admission.close();

    expect(captured).toEqual([]);
  },
);
