import { Compile } from "typebox/compile";
import { describe, it } from "vitest";
import { validateAuditRunInspectParams, validateExecutionIdentityContextV1 } from "../index.js";
import {
  AuditRunInspectParamsSchema,
  AuditRunInspectResultSchema,
  DecisionReceiptDisplayV1Schema,
  DecisionReceiptV1Schema,
  type ExecutionIdentityContextV1,
} from "./audit-run.js";
import { validation } from "./protocol-validation.test-support.js";

const inspect = Compile(AuditRunInspectParamsSchema);
const identityProof = validation(validateExecutionIdentityContextV1);
const hmacRef = `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`;
const identity: ExecutionIdentityContextV1 = {
  schemaVersion: 1,
  contextId: "context-1",
  executionId: "execution-1",
  runId: "run-1",
  createdAt: 1,
  trustDomain: { kind: "gateway-cell", domainRef: hmacRef, state: "present" },
  invoker: { state: "absent" },
  ingress: { kind: "local-cli", boundary: "local", state: "present" },
  agentPrincipal: { kind: "agent", domainRef: hmacRef, principalRef: "main" },
  agentDefinition: { definitionRef: "main", state: "present" },
  runtimeInstance: { runtimeRef: hmacRef, kind: "embedded", state: "present" },
  applicableGrants: [],
  assurance: [{ kind: "runtime-binding", evidenceRef: hmacRef, strength: "boundary-verified" }],
  coverageState: "unattributed",
  missingEvidence: ["invoker.principal"],
};

describe("audit run inspection protocol", () => {
  it("accepts the V1 context and truthful admission receipt", () => {
    identityProof.accepts(identity);
    const validate = Compile(DecisionReceiptV1Schema);
    const proof = validation((value) => validate.Check(value));
    proof.accepts({
      schemaVersion: 1,
      receiptId: "receipt-1",
      contextId: identity.contextId,
      executionId: identity.executionId,
      runId: identity.runId,
      occurredAt: identity.createdAt,
      action: { family: "run", operation: "admission" },
      decision: { outcome: "not-applicable", reasonCode: "not_evaluated" },
      enforcement: {
        coverageState: "unattributed",
        policyRefs: [],
        grantRefs: [],
        contextFieldsUsed: [],
      },
      source: {
        owner: "agent-command",
        recordRef: identity.contextId,
        decisionBoundary: "admission",
      },
      missingEvidence: ["invoker.principal"],
      remediation: [{ code: "none", text: "No enforcement is claimed." }],
    });
  });
  it.each([
    ["registered validator", validateAuditRunInspectParams],
    ["exported schema", (value: unknown) => inspect.Check(value)],
  ] as const)("enforces exact-run selection and query bounds via %s", (_name, validate) => {
    const selection = validation(validate);
    selection.accepts(
      { runId: "run-1", decisionLimit: 100 },
      { executionId: "execution-1" },
      { runId: "run-1", executionLimit: 50 },
      { runId: "run-1", executionCursor: "cursor-1" },
      { executionId: "execution-1", decisionLimit: 100 },
    );
    selection.rejects(
      {},
      { runId: "run-1", executionId: "execution-1" },
      { executionId: "execution-1", executionLimit: 2 },
      { executionId: "execution-1", executionCursor: "cursor-1" },
      { runId: "run-1", executionLimit: 51 },
      { runId: "", decisionLimit: 50 },
      { runId: "run-1", decisionLimit: 101 },
      { runId: "run-1", extra: true },
    );
  });
  it("accepts only the bounded safe decision display contract", () => {
    const validate = Compile(DecisionReceiptDisplayV1Schema);
    const proof = validation((value) => validate.Check(value));
    const display = {
      schemaVersion: 1,
      selectorId: "decision-fact:1",
      occurredAt: 1,
      action: { family: "decision", operation: "record" },
      decision: { outcome: "unknown", reasonCode: "unverified" },
      enforcement: {
        coverageState: "unknown",
        policyCount: 1,
        grantCount: 0,
        contextFieldsUsed: [],
      },
      provenance: { state: "unverified" },
      missingEvidence: ["decision.display_provenance"],
      remediation: [],
    };
    const representedSubject = {
      state: "present",
      principal: { kind: "person", domainRef: hmacRef, principalRef: hmacRef },
    };
    proof.accepts(display, { ...display, representedSubject });
    proof.rejects(
      ...[
        { displayLabel: "Private name" },
        { rawPrincipalRef: "private-profile" },
        { principalRef: "r".repeat(257) },
      ].map((invalid) =>
        Object.assign({}, display, {
          representedSubject: Object.assign({}, representedSubject, {
            principal: Object.assign({}, representedSubject.principal, invalid),
          }),
        }),
      ),
      { ...display, selectorId: undefined, receiptId: "hostile" },
      { ...display, source: { owner: "operator_approvals" } },
      { ...display, provenance: { state: "verified", producer: "receipt-owner" } },
    );
    const verified = (producer: string) => ({
      ...display,
      provenance: { state: "verified", producer },
    });
    proof.accepts(
      ...["run-admission", "operator-approval", "message-delivery", "cron-lifecycle"].map(verified),
    );
    proof.rejects(...["task-lifecycle", "flow-lifecycle"].map(verified));
  });
  it("requires safe-only decision presentation", () => {
    const validate = Compile(AuditRunInspectResultSchema);
    const proof = validation((value) => validate.Check(value));
    const result = {
      schemaVersion: 1,
      run: { runId: "run-1", status: "unknown" },
      identity: {
        state: "unknown",
        reasonCode: "run_not_found",
        missingEvidence: ["run.record"],
        remediation: [],
      },
      decisionDisplays: [],
      coverage: { state: "unknown", missingEvidence: ["run.record"] },
    };
    proof.accepts(result);
    proof.rejects({ ...result, decisionDisplays: undefined }, { ...result, decisions: [] });
  });
});
