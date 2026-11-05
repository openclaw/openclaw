// Inspect the package Gateway's public audit surface after direct-local Codex turns.
import assert from "node:assert/strict";

const HMAC_REF = /^hmac-sha256:v1:[a-f0-9]{32}:[a-f0-9]{64}$/u;

export function inspectCodexAudit({ query, selectors, expectedExecutions, privateValues }) {
  const inspect = (...args) => {
    const result = query(args);
    const encoded = JSON.stringify(result);
    for (const value of privateValues) {
      assert(!encoded.includes(value), "Codex audit exposed private workspace content");
    }
    assert(!Object.hasOwn(result, "decisions"), "Codex audit exposed raw decision receipts");
    return result;
  };
  assert.equal(selectors.length, expectedExecutions, "Codex turns did not retain three identities");
  const executionIds = new Set();
  const contextIds = new Set();
  for (const candidate of selectors) {
    const { runId } = candidate;
    assert.equal(typeof runId, "string");
    assert(runId.length > 0);
    assert.equal(typeof candidate.executionId, "string");
    assert(candidate.executionId.length > 0);
    const discovery = inspect("--run", runId, "--explain", "--limit", "50");
    assert.equal(discovery.run?.runId, runId, "Codex audit discovered the wrong run");
    assert.equal(discovery.run?.status, "known", "Codex audit run was not retained");
    assert.equal(
      discovery.identity?.state,
      "present",
      "Codex run discovery did not select its execution",
    );
    assert.equal(discovery.identity.context.executionId, candidate.executionId);
    assert.equal(discovery.identity.context.contextId, candidate.contextId);
    assert.equal(
      discovery.nextExecutionCursor,
      undefined,
      "Codex execution discovery was truncated",
    );
    const exact = inspect("--execution", candidate.executionId, "--explain", "--limit", "100");
    assert.equal(exact.schemaVersion, 1);
    assert.equal(exact.run?.status, "known");
    assert.equal(exact.run?.runId, runId);
    assert.equal(exact.run?.executionId, candidate.executionId);
    assert.equal(exact.identity?.state, "present", "Codex execution identity is missing");
    const context = exact.identity.context;
    assert.equal(context.runId, runId);
    assert.equal(context.executionId, candidate.executionId);
    assert.equal(context.contextId, candidate.contextId);
    assert.equal(typeof context.contextId, "string");
    assert(context.contextId.length > 0);
    assert.deepEqual(context.invoker, { state: "absent" }, "local CLI must not invent a person");
    assert.equal(context.ingress?.kind, "local-cli");
    assert.equal(context.ingress?.state, "present");
    assert.equal(context.agentPrincipal?.kind, "agent");
    assert.equal(context.agentPrincipal?.principalRef, "main");
    assert.equal(context.trustDomain?.state, "present");
    assert.equal(context.trustDomain?.kind, "gateway-cell");
    assert.match(context.trustDomain.domainRef, HMAC_REF);
    assert.equal(context.agentPrincipal.domainRef, context.trustDomain.domainRef);
    assert.equal(context.agentDefinition?.definitionRef, "main");
    assert.equal(context.runtimeInstance?.kind, "plugin-harness");
    assert.equal(context.runtimeInstance?.state, "present");
    assert.match(context.runtimeInstance.runtimeRef, HMAC_REF);
    assert.equal(context.coverageState, "unattributed");
    assert.deepEqual(context.applicableGrants, []);
    assert(
      context.assurance?.some(
        (evidence) =>
          evidence.kind === "runtime-binding" && evidence.strength === "boundary-verified",
      ),
      "Codex runtime binding assurance is missing",
    );
    for (const evidence of context.assurance) {
      assert.match(evidence.evidenceRef, HMAC_REF);
    }
    const admissions = exact.decisionDisplays?.filter(
      (receipt) =>
        receipt.provenance?.state === "verified" && receipt.provenance.producer === "run-admission",
    );
    assert.equal(admissions?.length, 1, "Codex admission receipt is missing or duplicated");
    const admission = admissions[0];
    assert.deepEqual(admission.action.family, "run");
    assert.deepEqual(admission.action.operation, "admission");
    assert.equal(admission.decision?.outcome, "not-applicable");
    assert.equal(admission.decision?.reasonCode, "run_admission_identity_not_evaluated");
    assert.equal(admission.enforcement?.coverageState, "unattributed");
    assert.equal(admission.enforcement?.grantCount, 0);
    assert.equal(admission.enforcement?.policyCount, 0);
    assert.equal(exact.nextDecisionCursor, undefined, "Codex decision inspection was truncated");
    assert(
      exact.decisionDisplays.every(
        (receipt) => receipt.provenance?.producer !== "operator-approval",
      ),
      "full-access Codex execution must not manufacture operator approval",
    );
    executionIds.add(context.executionId);
    contextIds.add(context.contextId);
  }
  assert.equal(executionIds.size, expectedExecutions, "Codex turns reused an execution id");
  assert.equal(contextIds.size, expectedExecutions, "Codex turns reused a context id");

  return { executionCount: executionIds.size };
}
