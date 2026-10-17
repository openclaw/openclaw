import path from "node:path";
import { describe, expect, it } from "vitest";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import type {
  QaEvidenceIdentity,
  QaEvidenceStatus,
  QaEvidenceSummaryJson,
  QaEvidenceSummaryV3Json,
} from "./evidence-summary.js";
import { qaProfileEvidencePlan } from "./profile-evidence-plan.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { expandQaScenarioExecutionCells, type QaScenarioExecutionCell } from "./scenario-lane.js";
import {
  qaMaturityTaxonomyIdentity,
  readQaMaturityTaxonomySource,
  qaProofRequirementsSchema,
  type QaProofRequirements,
} from "./scorecard-taxonomy.js";

const { attest, evaluateProof, schema } = qaProfileEvidencePlan;

describe("QA profile evidence plan", () => {
  const portable = readQaScenarioById("thread-isolation");
  const native = readQaScenarioById("control-ui-chat-flow-playwright");
  const excluded = readQaScenarioById("matrix-room-block-streaming");

  function buildPlan(observedCells: QaScenarioExecutionCell[]) {
    return qaProfileEvidencePlan.build({
      profile: "all",
      taxonomyIdentity: qaMaturityTaxonomyIdentity(
        readQaMaturityTaxonomySource(path.resolve(import.meta.dirname, "../../../taxonomy.yaml")),
      ),
      membershipScenarios: [excluded, native, portable],
      selectedScenarios: [portable, native],
      excludedScenarios: [{ scenario: excluded, reasons: ["providerMode=mock-openai"] }],
      expectedCells: expandQaScenarioExecutionCells({
        scenarios: [portable, native],
        channelDriver: "live",
        supportsChannel: (channel) => channel === "matrix" || channel === "slack",
        expandChannels: true,
      }),
      observedCells,
    });
  }

  const proofIdentity: QaEvidenceIdentity = {
    source: { ref: "fixture-source", integrity: "sha256:fixture-source" },
    runtime: { id: "openclaw", version: "1.2.3" },
    package: {
      kind: "npm-tarball",
      spec: "openclaw",
      version: "1.2.3",
      integrity: "sha256:fixture-package",
    },
    protocol: "gateway:3",
    accountRef: "fixture-account",
    proofClass: "real-plugin/local-protocol",
  };
  const requirements: QaProofRequirements = [
    {
      id: "channel-proof",
      coverageId: "channels.dm",
      obligation: "required",
      owner: "fixture-owner",
      acceptedRef: "qa/fixtures/acceptance",
      retryAcceptance: "selected-attempt",
      alternatives: [
        {
          sourceRef: "fixture-source",
          sourceIntegrity: "sha256:fixture-source",
          runtime: "openclaw",
          runtimeVersion: "1.2.3",
          packageIntegrity: "sha256:fixture-package",
          protocol: "gateway:3",
          accountRef: "fixture-account",
          proofClass: "real-plugin/local-protocol",
        },
      ],
    },
  ];
  function proofPlan() {
    return {
      ...buildPlan([
        { scenarioId: native.id, executionKind: "playwright", channel: null },
        { scenarioId: portable.id, executionKind: "flow", channel: "matrix" },
        { scenarioId: portable.id, executionKind: "flow", channel: "slack" },
      ]),
      proofRequirements: structuredClone(requirements),
    };
  }
  function receipt(
    id: string,
    phase: "runtime" | "prepared",
    filePath: string,
    identity = proofIdentity,
  ) {
    return {
      id,
      phase,
      identity,
      artifact: {
        kind: phase === "runtime" ? "fixture" : "producer-evidence",
        source: phase === "runtime" ? "qa-suite" : "script",
        path: filePath,
        sha256: "a".repeat(64),
      },
    };
  }
  function proofInvocation() {
    const owner = createQaEvidenceInvocation({
      scenarios: [
        {
          ...portable,
          assertions: [
            {
              id: "assertion-one",
              meaning: "the declared local protocol result",
              coverage: [{ id: "channels.dm", role: "primary" }],
            },
          ],
        },
      ],
      channel: "slack",
      launch: proofIdentity,
    });
    function complete(
      id: string,
      rows: Array<{ status: QaEvidenceStatus; identity?: QaEvidenceIdentity }>,
      status: QaEvidenceStatus = rows.some((row) => row.status === "fail") ? "fail" : "pass",
    ) {
      owner.complete(id, {
        status,
        entries: rows.map((row, index) => ({
          test: { kind: "flow", id: portable.id, title: "proof fixture" },
          coverage: [{ id: "channels.dm", role: "primary" }],
          result: { status: row.status },
          binding: {
            occurrenceId: id,
            assertionId: "assertion-one",
            receiptId: `receipt-${index}`,
          },
          effective: true,
        })),
        receipts: rows.map((row, index) =>
          receipt(`receipt-${index}`, "runtime", `artifacts/${id}-${index}.json`, row.identity),
        ),
      });
      owner.select(0, id);
    }
    function record(
      rows: Parameters<typeof complete>[1],
      status?: QaEvidenceStatus,
      retryOf?: string | null,
    ) {
      const id = owner.begin(0, retryOf);
      complete(id, rows, status);
      return id;
    }
    return { owner, complete, record };
  }
  function proofEvidence(
    rows: Array<{ status: QaEvidenceStatus; identity?: QaEvidenceIdentity }>,
    mode: "full" | "slim" = "full",
  ) {
    const { owner, record } = proofInvocation();
    record(rows);
    return snapshot(owner, mode);
  }
  function snapshot(
    owner: ReturnType<typeof createQaEvidenceInvocation>,
    evidenceMode: "full" | "slim" = "full",
  ) {
    return owner.snapshot({ generatedAt: "2026-09-13T00:00:00Z", evidenceMode });
  }
  function evaluate(evidence: QaEvidenceSummaryJson, plan = proofPlan()) {
    return evaluateProof(plan, evidence)[0]!;
  }
  function proofCheck(occurrenceId: string, status: string) {
    return { occurrenceId, assertionId: "assertion-one", status };
  }

  it("applies captured coverage caps to both retry policies in slim evidence", () => {
    const evidenceMode = "slim";
    for (const caseName of ["primary", "secondary", "rowless"] as const) {
      const role = caseName === "secondary" ? "secondary" : "primary";
      const parent = createQaEvidenceInvocation({
        scenarios: [portable],
        channel: "slack",
        launch: proofIdentity,
      });
      const first = proofEvidence([{ status: "fail" }], evidenceMode);
      const second = proofEvidence(
        caseName === "rowless" ? [] : [{ status: "pass" }],
        evidenceMode,
      );
      for (const [index, childEvidence] of [first, second].entries()) {
        const status = index === 0 ? "fail" : "pass";
        const id = parent.begin(0);
        parent.complete(id, {
          status,
          childEvidence,
          childCoverage: [{ id: "channels.dm", role: index === 0 ? "primary" : role }],
          entries: [
            {
              test: { id: portable.id, kind: "script", title: "enclosing attempt" },
              coverage: [],
              result: { status },
            },
          ],
          receipts: [receipt(`${id}:bundle`, "prepared", `${id}/qa-evidence.json`)],
        });
        parent.select(0, id);
      }
      const evidence = parent.snapshot({ generatedAt: "2026-09-14T00:00:00Z", evidenceMode });
      const original = JSON.stringify(evidence);
      for (const retryAcceptance of ["selected-attempt", "all-recorded-attempts"] as const) {
        const plan = proofPlan();
        plan.proofRequirements = plan.proofRequirements.map((item) => ({
          ...item,
          retryAcceptance,
        }));
        const proof = evaluate(evidence, plan);
        expect(proof.qualified).toBe(
          caseName === "primary" && retryAcceptance === "selected-attempt",
        );
        if (retryAcceptance === "all-recorded-attempts") {
          expect(proof.checks.some((check) => check.status === "failed")).toBe(true);
        }
        if (caseName === "rowless") {
          expect(proof.checks.some((check) => check.status === "incomplete")).toBe(true);
        }
      }
      expect(JSON.stringify(evidence)).toBe(original);
      expect(evaluate(second).qualified).toBe(caseName !== "rowless");
    }
  });

  it("keeps synthetic observations out of child assertion obligations in slim evidence", () => {
    const evidenceMode = "slim";
    const { owner, complete } = proofInvocation();
    const dispatch = owner.begin(0, null, { diagnostic: true });
    const child = owner.begin(0, null);
    complete(child, [{ status: "pass" }]);
    owner.complete(dispatch, { status: "pass", entries: [] });
    owner.select(0, child);
    const evidence = snapshot(owner, evidenceMode);
    const original = structuredClone(evidence);
    const plan = proofPlan();
    plan.proofRequirements[0]!.retryAcceptance = "all-recorded-attempts";
    expect(attest(plan, true, evidence).proof?.[0]?.qualified).toBe(true);
    expect(evidence.occurrences.find((item) => item.id === dispatch)?.assertions).toBeNull();
    expect(evidence).toEqual(original);

    const incomplete = owner.begin(0, null);
    owner.complete(incomplete, { status: "fail", entries: [] });
    owner.select(0, incomplete);
    const failed = snapshot(owner, evidenceMode);
    expect(failed.occurrences.find((item) => item.id === incomplete)?.assertions).toHaveLength(1);
    expect(evaluate(failed, plan).checks).toEqual([
      expect.objectContaining({ occurrenceId: child, status: "qualified" }),
      expect.objectContaining({ occurrenceId: incomplete, status: "incomplete" }),
    ]);
    expect(() => attest(plan, true, failed)).toThrow("unqualified declared proof");
  });

  it("classifies prepared identity without inventing a product failure", () => {
    const evidence = proofEvidence([{ status: "pass" }]);
    evidence.occurrences[1]!.receipts[0]!.phase = "prepared";
    const result = evaluate(evidence);
    expect(result.qualified).toBe(false);
    expect(result.checks.map((check) => check.status)).toEqual(["insufficient"]);
    expect(evidence.entries[0]?.result.status).toBe("pass");
  });

  it.each([
    { statuses: ["pass", "fail"], expected: "conflict" },
    { statuses: ["skipped"], expected: "partial" },
  ] as const)(
    "retains $statuses while classifying a required assertion",
    ({ statuses, expected }) => {
      const evidence = proofEvidence(statuses.map((status) => ({ status })));
      expect(evaluate(evidence).checks[0]?.status).toBe(expected);
      expect(evidence.entries.map((entry) => entry.result.status)).toEqual(statuses);
      expect(() => attest(proofPlan(), true, evidence)).toThrow(`channel-proof (${expected})`);
    },
  );

  it("distinguishes a prerequisite incident from an omitted started assertion", () => {
    const { owner, record } = proofInvocation();
    record([], "blocked");
    const evidence = snapshot(owner);
    const plan = proofPlan();
    expect(evaluate(evidence, plan).checks[0]?.status).toBe("incomplete");
    const missingPlan = {
      ...buildPlan([
        { scenarioId: native.id, executionKind: "playwright", channel: null },
        { scenarioId: portable.id, executionKind: "flow", channel: "matrix" },
      ]),
      proofRequirements: requirements,
    };
    expect(evaluate(evidence, missingPlan).checks[0]?.status).toBe("prerequisite");
  });

  it.each([
    { name: "rejected", firstRows: [{ status: "pass" }], status: "skipped", selected: false },
    { name: "selected", firstRows: [], status: "pass", selected: true },
  ] as const)("preserves $name rowless retry selection", ({ firstRows, status, selected }) => {
    for (const evidenceMode of ["full", "slim"] as const) {
      const { owner, record } = proofInvocation();
      const first = record([...firstRows], "fail");
      const retry = record([], status, first);
      const evidence = snapshot(owner, evidenceMode);
      const original = structuredClone(evidence);
      const plan = proofPlan();
      expect(owner.selectedObservation(0)?.occurrence.id).toBe(selected ? retry : first);
      expect(evaluate(evidence, plan).checks).toEqual([
        proofCheck(selected ? retry : first, selected ? "incomplete" : "qualified"),
      ]);
      if (!selected) {
        expect(attest(plan, true, evidence).proof?.[0]?.qualified).toBe(true);
        plan.proofRequirements[0]!.retryAcceptance = "all-recorded-attempts";
        expect(evaluate(evidence, plan).checks).toEqual([
          proofCheck(first, "qualified"),
          proofCheck(retry, "incomplete"),
        ]);
      }
      expect(() => attest(plan, true, evidence)).toThrow("unqualified declared proof");
      expect(evidence).toEqual(original);
    }
  });

  it("retains independent rowless observations in selected-attempt proof", () => {
    const { owner, record } = proofInvocation();
    const first = record([{ status: "pass" }]);
    const independent = record([], "blocked", null);
    const evidence = snapshot(owner);
    const original = structuredClone(evidence);
    expect(evaluate(evidence).checks).toEqual([
      proofCheck(first, "qualified"),
      proofCheck(independent, "incomplete"),
    ]);
    expect(evidence).toEqual(original);
  });

  it("does not pool source and package proof from unrelated observations", () => {
    const { owner, complete } = proofInvocation();
    complete(owner.begin(0, null), [
      {
        status: "pass",
        identity: {
          ...proofIdentity,
          package: { ...proofIdentity.package!, integrity: "other" },
        },
      },
    ]);
    complete(owner.begin(0, null), [
      {
        status: "pass",
        identity: { ...proofIdentity, source: { ...proofIdentity.source, ref: "other" } },
      },
    ]);
    const evidence = snapshot(owner);
    expect(evaluate(evidence).qualified).toBe(false);
    const plan = proofPlan();
    plan.proofRequirements[0]!.alternatives = [{ protocol: "gateway:3" }];
    // The first observation satisfies this explicitly sparse alternative; the
    // second still contradicts its own captured launch source.
    expect(evaluate(evidence, plan).checks.map((check) => check.status)).toEqual([
      "qualified",
      "stale",
    ]);
  });

  it("keeps historical or stale semantic identity unqualified and leaves absent obligations alone", () => {
    const plan = proofPlan();
    const evidence = proofEvidence([{ status: "pass" }]);
    const { occurrences: _occurrences, ...withoutOccurrences } = evidence;
    const legacy = {
      ...withoutOccurrences,
      schemaVersion: 2 as const,
      entries: evidence.entries.map(({ binding: _binding, effective: _effective, ...row }) => row),
    };
    expect(evaluate(legacy, plan).checks[0]?.status).toBe("insufficient");
    const old = structuredClone(evidence) as QaEvidenceSummaryV3Json;
    old.profilePlan = { ...plan, taxonomyIdentity: { version: 1, sha256: "0".repeat(64) } };
    expect(evaluate(old, plan).checks[0]?.status).toBe("stale");
    delete old.profilePlan.taxonomyIdentity;
    expect(evaluate(old, plan).checks[0]?.status).toBe("insufficient");
    const { proofRequirements: _requirements, ...withoutRequirements } = plan;
    expect(attest(withoutRequirements, true, old)).not.toHaveProperty("proof");
  });

  it("accepts complete plans and rejects unexpected or non-canonical cells", () => {
    const complete = buildPlan([
      { scenarioId: portable.id, executionKind: "flow", channel: "slack" },
      { scenarioId: portable.id, executionKind: "flow", channel: "matrix" },
      { scenarioId: native.id, executionKind: "playwright", channel: null },
    ]);
    expect(attest(complete, true).plan).toEqual(complete);

    expect(() =>
      buildPlan([
        ...complete.observedCells,
        { scenarioId: portable.id, executionKind: "flow", channel: "telegram" },
      ]),
    ).toThrow("unexpected execution cells invalidate evidence");
    expect(
      schema.safeParse({
        ...complete,
        expectedCells: complete.expectedCells.toReversed(),
      }).success,
    ).toBe(false);
  });

  it("attests only explicit owner-accepted proof requirements and preserves unknown absence", () => {
    const plan = buildPlan([]);
    const declaredRequirements = qaProofRequirementsSchema.parse([
      {
        id: "native-install",
        coverageId: "channels.dm",
        obligation: "advisory",
        owner: "synthetic-owner",
        acceptedRef: "qa/fixtures/acceptance",
        alternatives: [
          { proofClass: "packaged-install/upgrade", packageIntegrity: "sha512-candidate" },
        ],
        retryAcceptance: "all-recorded-attempts",
      },
    ]);
    const captured = attest({
      ...plan,
      proofRequirements: declaredRequirements,
    });
    expect(captured.plan.proofRequirements).toEqual(declaredRequirements);
    expect(captured.sha256).not.toBe(attest(plan).sha256);
    expect(plan).not.toHaveProperty("proofRequirements");
    for (const invalid of [
      { owner: "" },
      { acceptedRef: undefined },
      { retryAcceptance: undefined },
      { alternatives: [{}] },
    ]) {
      expect(() =>
        qaProofRequirementsSchema.parse([{ ...declaredRequirements[0], ...invalid }]),
      ).toThrow();
    }
    expect(() =>
      qaProofRequirementsSchema.parse([declaredRequirements[0], declaredRequirements[0]]),
    ).toThrow();
  });
});
