// QA Lab tests cover canonical profile scheduling evidence.
import path from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import type {
  QaEvidenceIdentity,
  QaEvidenceStatus,
  QaEvidenceSummaryV3Json,
} from "./evidence-summary.js";
import { qaProfileEvidencePlan } from "./profile-evidence-plan.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { expandQaScenarioExecutionCells, type QaScenarioExecutionCell } from "./scenario-lane.js";
import {
  qaMaturityTaxonomyIdentity,
  readQaMaturityTaxonomySource,
  qaProofRequirementsSchema,
  type QaMaturityTaxonomyIdentity,
  type QaProofRequirements,
} from "./scorecard-taxonomy.js";

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
        receipts: rows.map((row, index) => ({
          id: `receipt-${index}`,
          phase: "runtime",
          identity: row.identity ?? proofIdentity,
          artifact: {
            kind: "fixture",
            source: "qa-suite",
            path: `artifacts/${id}-${index}.json`,
            sha256: "a".repeat(64),
          },
        })),
      });
      owner.select(0, id);
    }
    return { owner, complete };
  }
  function proofEvidence(
    rows: Array<{ status: QaEvidenceStatus; identity?: QaEvidenceIdentity }>,
    mode: "full" | "slim" = "full",
  ) {
    const { owner, complete } = proofInvocation();
    complete(owner.begin(0), rows);
    return owner.snapshot({ generatedAt: "2026-09-13T00:00:00Z", evidenceMode: mode });
  }

  it.each(["full", "slim"] as const)(
    "applies captured coverage caps to both retry policies in %s evidence",
    (evidenceMode) => {
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
            receipts: [
              {
                id: `${id}:bundle`,
                phase: "prepared",
                identity: proofIdentity,
                artifact: {
                  kind: "producer-evidence",
                  source: "script",
                  path: `${id}/qa-evidence.json`,
                  sha256: "a".repeat(64),
                },
              },
            ],
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
          const [proof] = qaProfileEvidencePlan.evaluateProof(plan, evidence);
          expect(proof!.qualified).toBe(
            caseName === "primary" && retryAcceptance === "selected-attempt",
          );
          if (retryAcceptance === "all-recorded-attempts") {
            expect(proof!.checks.some((check) => check.status === "failed")).toBe(true);
          }
          if (caseName === "rowless") {
            expect(proof!.checks.some((check) => check.status === "incomplete")).toBe(true);
          }
        }
        expect(JSON.stringify(evidence)).toBe(original);
        expect(qaProfileEvidencePlan.evaluateProof(proofPlan(), second)[0]!.qualified).toBe(
          caseName !== "rowless",
        );
      }
    },
  );

  it.each(["full", "slim"] as const)(
    "keeps synthetic observations out of child assertion obligations in %s evidence",
    (evidenceMode) => {
      const { owner, complete } = proofInvocation();
      const dispatch = owner.begin(0, null, { diagnostic: true });
      const child = owner.begin(0, null);
      complete(child, [{ status: "pass" }]);
      owner.complete(dispatch, { status: "pass", entries: [] });
      owner.select(0, child);
      const evidence = owner.snapshot({
        generatedAt: "2026-09-13T00:00:00Z",
        evidenceMode,
      });
      const original = structuredClone(evidence);
      const plan = proofPlan();
      plan.proofRequirements[0]!.retryAcceptance = "all-recorded-attempts";
      expect(qaProfileEvidencePlan.attest(plan, true, evidence).proof?.[0]?.qualified).toBe(true);
      expect(evidence.occurrences.find((item) => item.id === dispatch)?.assertions).toBeNull();
      expect(evidence).toEqual(original);

      const incomplete = owner.begin(0, null);
      owner.complete(incomplete, { status: "fail", entries: [] });
      owner.select(0, incomplete);
      const failed = owner.snapshot({
        generatedAt: "2026-09-13T00:00:00Z",
        evidenceMode,
      });
      expect(failed.occurrences.find((item) => item.id === incomplete)?.assertions).toHaveLength(1);
      expect(qaProfileEvidencePlan.evaluateProof(plan, failed)[0]?.checks).toEqual([
        expect.objectContaining({ occurrenceId: child, status: "qualified" }),
        expect.objectContaining({ occurrenceId: incomplete, status: "incomplete" }),
      ]);
      expect(() => qaProfileEvidencePlan.attest(plan, true, failed)).toThrow(
        "unqualified declared proof",
      );
    },
  );

  it.each(["full", "slim"] as const)(
    "qualifies one assertion with its bound target receipt in %s evidence",
    (mode) => {
      const evidence = proofEvidence([{ status: "pass" }], mode);
      const original = structuredClone(evidence);
      const plan = proofPlan();
      const result = qaProfileEvidencePlan.attest(plan, true, evidence);
      expect(result.proof).toEqual([
        expect.objectContaining({
          id: "channel-proof",
          qualified: true,
          checks: [expect.objectContaining({ assertionId: "assertion-one", status: "qualified" })],
        }),
      ]);
      expect(result.sha256).toBe(qaProfileEvidencePlan.attest(plan).sha256);
      expect(evidence).toEqual(original);
    },
  );

  it.each([
    { field: "source", expected: "stale" },
    { field: "package", expected: "stale" },
    { field: "runtime", expected: "stale" },
    { field: "account", expected: "stale" },
    { field: "unknown", expected: "insufficient" },
    { field: "class", expected: "insufficient" },
    { field: "prepared", expected: "insufficient" },
  ])("classifies $field identity without inventing a product failure", ({ field, expected }) => {
    const identity = structuredClone(proofIdentity);
    if (field === "source") {
      identity.source.ref = "different-source";
    }
    if (field === "package") {
      identity.package!.integrity = "different-package";
    }
    if (field === "runtime") {
      identity.runtime.version = "different-version";
    }
    if (field === "account") {
      identity.accountRef = "different-account";
    }
    if (field === "unknown") {
      identity.runtime.version = null;
    }
    if (field === "class") {
      identity.proofClass = "fixture-only";
    }
    const evidence = proofEvidence([{ status: "pass", identity }]);
    if (field === "prepared") {
      evidence.occurrences[1]!.receipts[0]!.phase = "prepared";
    }
    const [result] = qaProfileEvidencePlan.evaluateProof(proofPlan(), evidence);
    expect(result?.qualified).toBe(false);
    expect(result?.checks.map((check) => check.status)).toEqual([expected]);
    expect(evidence.entries[0]?.result.status).toBe("pass");
  });

  it.each([
    { statuses: ["pass", "fail"], expected: "conflict" },
    { statuses: ["fail"], expected: "failed" },
    { statuses: ["blocked"], expected: "partial" },
    { statuses: ["skipped"], expected: "partial" },
  ] as const)(
    "retains $statuses while classifying a required assertion",
    ({ statuses, expected }) => {
      const evidence = proofEvidence(statuses.map((status) => ({ status })));
      expect(qaProfileEvidencePlan.evaluateProof(proofPlan(), evidence)[0]?.checks[0]?.status).toBe(
        expected,
      );
      expect(evidence.entries.map((entry) => entry.result.status)).toEqual(statuses);
      expect(() => qaProfileEvidencePlan.attest(proofPlan(), true, evidence)).toThrow(
        `channel-proof (${expected})`,
      );
    },
  );

  it("distinguishes a prerequisite incident from an omitted started assertion", () => {
    const { owner, complete } = proofInvocation();
    complete(owner.begin(0), [], "blocked");
    const evidence = owner.snapshot({ generatedAt: "2026-09-13T00:00:00Z" });
    const plan = proofPlan();
    expect(qaProfileEvidencePlan.evaluateProof(plan, evidence)[0]?.checks[0]?.status).toBe(
      "incomplete",
    );
    const missingPlan = {
      ...buildPlan([
        { scenarioId: native.id, executionKind: "playwright", channel: null },
        { scenarioId: portable.id, executionKind: "flow", channel: "matrix" },
      ]),
      proofRequirements: requirements,
    };
    expect(qaProfileEvidencePlan.evaluateProof(missingPlan, evidence)[0]?.checks[0]?.status).toBe(
      "prerequisite",
    );
  });

  it("honors the declared whole-attempt retry policy and keeps advisory failures diagnostic", () => {
    const { owner, complete } = proofInvocation();
    const first = owner.begin(0);
    complete(first, [{ status: "fail" }]);
    complete(owner.begin(0, first), [{ status: "pass" }]);
    const evidence = owner.snapshot({ generatedAt: "2026-09-13T00:00:00Z" });
    const plan = proofPlan();
    expect(qaProfileEvidencePlan.evaluateProof(plan, evidence)[0]?.qualified).toBe(true);
    plan.proofRequirements[0]!.retryAcceptance = "all-recorded-attempts";
    expect(
      qaProfileEvidencePlan.evaluateProof(plan, evidence)[0]?.checks.map((check) => check.status),
    ).toEqual(["failed", "qualified"]);
    expect(() => qaProfileEvidencePlan.attest(plan, true, evidence)).toThrow(
      "unqualified declared proof",
    );
    plan.proofRequirements[0]!.obligation = "advisory";
    expect(qaProfileEvidencePlan.attest(plan, true, evidence).proof?.[0]?.qualified).toBe(false);
  });

  it.each(["fail", "blocked", "skipped"] as const)(
    "excludes a rejected rowless %s retry only from selected-attempt proof",
    (status) => {
      for (const evidenceMode of ["full", "slim"] as const) {
        const { owner, complete } = proofInvocation();
        const first = owner.begin(0);
        complete(first, [{ status: "pass" }], "fail");
        const retry = owner.begin(0, first);
        complete(retry, [], status);
        const evidence = owner.snapshot({
          generatedAt: "2026-09-13T00:00:00Z",
          evidenceMode,
        });
        const original = structuredClone(evidence);
        const plan = proofPlan();
        expect(owner.selectedObservation(0)?.occurrence.id).toBe(first);
        expect(qaProfileEvidencePlan.evaluateProof(plan, evidence)[0]?.checks).toEqual([
          { occurrenceId: first, assertionId: "assertion-one", status: "qualified" },
        ]);
        expect(qaProfileEvidencePlan.attest(plan, true, evidence).proof?.[0]?.qualified).toBe(true);
        plan.proofRequirements[0]!.retryAcceptance = "all-recorded-attempts";
        expect(qaProfileEvidencePlan.evaluateProof(plan, evidence)[0]?.checks).toEqual([
          { occurrenceId: first, assertionId: "assertion-one", status: "qualified" },
          { occurrenceId: retry, assertionId: "assertion-one", status: "incomplete" },
        ]);
        expect(() => qaProfileEvidencePlan.attest(plan, true, evidence)).toThrow(
          "unqualified declared proof",
        );
        expect(evidence).toEqual(original);
      }
    },
  );

  it("keeps selected rowless retries incomplete while retiring their predecessor proof", () => {
    for (const evidenceMode of ["full", "slim"] as const) {
      const { owner, complete } = proofInvocation();
      const first = owner.begin(0);
      complete(first, [], "fail");
      const retry = owner.begin(0, first);
      complete(retry, [], "pass");
      const evidence = owner.snapshot({
        generatedAt: "2026-09-13T00:00:00Z",
        evidenceMode,
      });
      const original = structuredClone(evidence);
      const plan = proofPlan();
      expect(owner.selectedObservation(0)?.occurrence.id).toBe(retry);
      expect(qaProfileEvidencePlan.evaluateProof(plan, evidence)[0]?.checks).toEqual([
        { occurrenceId: retry, assertionId: "assertion-one", status: "incomplete" },
      ]);
      expect(() => qaProfileEvidencePlan.attest(plan, true, evidence)).toThrow(
        "unqualified declared proof",
      );
      expect(evidence).toEqual(original);
    }
  });

  it("retains independent rowless observations in selected-attempt proof", () => {
    const { owner, complete } = proofInvocation();
    const first = owner.begin(0);
    complete(first, [{ status: "pass" }]);
    const independent = owner.begin(0, null);
    complete(independent, [], "blocked");
    const evidence = owner.snapshot({ generatedAt: "2026-09-13T00:00:00Z" });
    const original = structuredClone(evidence);
    expect(qaProfileEvidencePlan.evaluateProof(proofPlan(), evidence)[0]?.checks).toEqual([
      { occurrenceId: first, assertionId: "assertion-one", status: "qualified" },
      { occurrenceId: independent, assertionId: "assertion-one", status: "incomplete" },
    ]);
    expect(evidence).toEqual(original);
  });

  it("does not pool source and package proof from unrelated observations", () => {
    const { owner, complete } = proofInvocation();
    complete(owner.begin(0, null), [
      {
        status: "pass",
        identity: { ...proofIdentity, package: { ...proofIdentity.package!, integrity: "other" } },
      },
    ]);
    complete(owner.begin(0, null), [
      {
        status: "pass",
        identity: { ...proofIdentity, source: { ...proofIdentity.source, ref: "other" } },
      },
    ]);
    const evidence = owner.snapshot({ generatedAt: "2026-09-13T00:00:00Z" });
    expect(qaProfileEvidencePlan.evaluateProof(proofPlan(), evidence)[0]?.qualified).toBe(false);
    const plan = proofPlan();
    plan.proofRequirements[0]!.alternatives = [{ protocol: "gateway:3" }];
    // The first observation satisfies this explicitly sparse alternative; the
    // second still contradicts its own captured launch source.
    expect(
      qaProfileEvidencePlan.evaluateProof(plan, evidence)[0]?.checks.map((check) => check.status),
    ).toEqual(["qualified", "stale"]);
  });

  it("applies selected versus all-recorded proof policy through enclosing native attempts", () => {
    const parent = createQaEvidenceInvocation({
      scenarios: [{ id: "native", execution: { kind: "script" } }],
      channel: null,
      launch: proofIdentity,
    });
    for (const status of ["fail", "pass"] as const) {
      const childEvidence = proofEvidence([{ status }]);
      const id = parent.begin(0);
      parent.complete(id, {
        status,
        childEvidence,
        entries: [
          {
            test: { kind: "script", id: "native", title: "Native command" },
            coverage: [],
            result: { status },
          },
        ],
        receipts: [
          {
            id: `${id}:bundle`,
            phase: "prepared",
            identity: proofIdentity,
            artifact: {
              kind: "producer-evidence",
              source: "script",
              path: `${id}/qa-evidence.json`,
              sha256: "a".repeat(64),
            },
          },
        ],
      });
      parent.select(0, id);
    }
    const evidence = parent.snapshot({ generatedAt: "2026-09-13T00:00:00Z" });
    const raw = structuredClone(evidence);
    const plan = proofPlan();
    expect(qaProfileEvidencePlan.evaluateProof(plan, evidence)[0]?.qualified).toBe(true);
    plan.proofRequirements[0]!.retryAcceptance = "all-recorded-attempts";
    expect(
      qaProfileEvidencePlan.evaluateProof(plan, evidence)[0]?.checks.map((check) => check.status),
    ).toEqual(["failed", "qualified"]);
    plan.proofRequirements[0]!.obligation = "advisory";
    expect(qaProfileEvidencePlan.attest(plan, true, evidence).proof?.[0]?.qualified).toBe(false);
    expect(evidence).toEqual(raw);
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
    expect(qaProfileEvidencePlan.evaluateProof(plan, legacy)[0]?.checks[0]?.status).toBe(
      "insufficient",
    );
    const old = structuredClone(evidence) as QaEvidenceSummaryV3Json;
    old.profilePlan = { ...plan, taxonomyIdentity: { version: 1, sha256: "0".repeat(64) } };
    expect(qaProfileEvidencePlan.evaluateProof(plan, old)[0]?.checks[0]?.status).toBe("stale");
    delete old.profilePlan.taxonomyIdentity;
    expect(qaProfileEvidencePlan.evaluateProof(plan, old)[0]?.checks[0]?.status).toBe(
      "insufficient",
    );
    const { proofRequirements: _requirements, ...withoutRequirements } = plan;
    expect(qaProfileEvidencePlan.attest(withoutRequirements, true, old)).not.toHaveProperty(
      "proof",
    );
  });

  it("records a deterministic membership partition and exact execution cells", () => {
    const plan = buildPlan([
      { scenarioId: native.id, executionKind: "playwright", channel: null },
      { scenarioId: portable.id, executionKind: "flow", channel: "slack" },
    ]);

    expect(plan.counts).toEqual({
      membership: 3,
      selected: 2,
      excluded: 1,
      expectedCells: 3,
      observedCells: 2,
      missingCells: 1,
    });
    expect(plan.expectedCells).toEqual([
      { scenarioId: native.id, executionKind: "playwright", channel: null },
      { scenarioId: portable.id, executionKind: "flow", channel: "matrix" },
      { scenarioId: portable.id, executionKind: "flow", channel: "slack" },
    ]);
    expect(plan.missingCells).toEqual([
      { scenarioId: portable.id, executionKind: "flow", channel: "matrix" },
    ]);
    expect(qaProfileEvidencePlan.attest(plan).plan).toEqual(plan);
    expect(() => qaProfileEvidencePlan.attest(plan, true)).toThrow(
      "successful QA profile evidence is missing 1 expected execution cell",
    );
  });

  it("accepts complete plans and rejects unexpected or non-canonical cells", () => {
    const complete = buildPlan([
      { scenarioId: portable.id, executionKind: "flow", channel: "slack" },
      { scenarioId: portable.id, executionKind: "flow", channel: "matrix" },
      { scenarioId: native.id, executionKind: "playwright", channel: null },
    ]);
    expect(qaProfileEvidencePlan.attest(complete, true).plan).toEqual(complete);

    expect(() =>
      buildPlan([
        ...complete.observedCells,
        { scenarioId: portable.id, executionKind: "flow", channel: "telegram" },
      ]),
    ).toThrow("unexpected execution cells invalidate evidence");
    expect(
      qaProfileEvidencePlan.schema.safeParse({
        ...complete,
        expectedCells: complete.expectedCells.toReversed(),
      }).success,
    ).toBe(false);
  });

  it("includes semantic identity in attestation", () => {
    expectTypeOf<
      Parameters<typeof qaProfileEvidencePlan.build>[0]["taxonomyIdentity"]
    >().toEqualTypeOf<QaMaturityTaxonomyIdentity>();
    const plan = buildPlan([]);
    expect(
      qaProfileEvidencePlan.attest({
        ...plan,
        taxonomyIdentity: { version: 1, sha256: "0".repeat(64) },
      }).sha256,
    ).not.toBe(qaProfileEvidencePlan.attest(plan).sha256);
    expect(() =>
      Reflect.apply(qaProfileEvidencePlan.build, undefined, [
        {
          profile: "all",
          membershipScenarios: [],
          selectedScenarios: [],
          excludedScenarios: [],
          expectedCells: [],
          observedCells: [],
          taxonomyIdentity: undefined,
        },
      ]),
    ).toThrow();
  });

  it("preserves historical plan bytes and its fixed attestation digest", () => {
    const cell = { scenarioId: "historical-scenario", executionKind: "flow", channel: "telegram" };
    const historical = {
      profile: "all",
      membership: ["historical-scenario"],
      selected: ["historical-scenario"],
      excluded: [],
      expectedCells: [cell],
      observedCells: [cell],
      missingCells: [],
      counts: {
        membership: 1,
        selected: 1,
        excluded: 0,
        expectedCells: 1,
        observedCells: 1,
        missingCells: 0,
      },
    };
    const attestation = qaProfileEvidencePlan.attest(historical, true);
    expect(JSON.stringify(attestation.plan)).toBe(JSON.stringify(historical));
    expect(attestation.plan).not.toHaveProperty("taxonomyIdentity");
    expect(attestation.sha256).toBe(
      "6c09166ba9ba6719862d917a29795165a90997cdc5658cd4c65e3a10d89e0fa1",
    );
  });

  it("normalizes object key order before workflow hashing", () => {
    const plan = buildPlan([
      { scenarioId: native.id, executionKind: "playwright", channel: null },
      { scenarioId: portable.id, executionKind: "flow", channel: "matrix" },
      { scenarioId: portable.id, executionKind: "flow", channel: "slack" },
    ]);
    const reordered = Object.fromEntries(Object.entries(plan).toReversed());

    expect(qaProfileEvidencePlan.attest(reordered, true)).toEqual(
      qaProfileEvidencePlan.attest(plan, true),
    );
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
    const captured = qaProfileEvidencePlan.attest({
      ...plan,
      proofRequirements: declaredRequirements,
    });
    expect(captured.plan.proofRequirements).toEqual(declaredRequirements);
    expect(captured.sha256).not.toBe(qaProfileEvidencePlan.attest(plan).sha256);
    expect(plan).not.toHaveProperty("proofRequirements");
    expect(() =>
      qaProofRequirementsSchema.parse([{ ...declaredRequirements[0], owner: "" }]),
    ).toThrow();
    expect(() =>
      qaProofRequirementsSchema.parse([{ ...declaredRequirements[0], acceptedRef: undefined }]),
    ).toThrow();
    expect(() =>
      qaProofRequirementsSchema.parse([{ ...declaredRequirements[0], retryAcceptance: undefined }]),
    ).toThrow();
    expect(() =>
      qaProofRequirementsSchema.parse([{ ...declaredRequirements[0], alternatives: [{}] }]),
    ).toThrow();
    expect(() =>
      qaProofRequirementsSchema.parse([declaredRequirements[0], declaredRequirements[0]]),
    ).toThrow();
  });
});
