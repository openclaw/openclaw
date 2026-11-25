import { describe, expect, it } from "vitest";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import {
  getEffectiveQaEvidenceEntries,
  projectQaEvidenceScenarioOutcomes,
  type QaEvidenceIdentity,
  type QaEvidenceSummaryEntry,
} from "./evidence-summary.js";

const scenario = { id: "duplicate-label", execution: { kind: "script" as const } };
const launch: QaEvidenceIdentity = {
  source: { ref: "source-A", integrity: "tree-A" },
  runtime: { id: "node", version: "26.1.0" },
  package: {
    kind: "packed-tarball",
    spec: "candidate.tgz",
    version: "2026.9.1",
    integrity: "sha512-A",
  },
  protocol: "local-http",
  accountRef: "synthetic-account",
  proofClass: "fixture-only",
};
const snapshotOptions = { generatedAt: "2026-09-13T00:00:00.000Z" };

function entry(status: "pass" | "fail"): QaEvidenceSummaryEntry {
  return {
    test: { kind: "script-test", id: "duplicate-label", title: "Synthetic check" },
    coverage: [{ id: "channels.dm", role: "primary" }],
    result: { status },
  };
}

function createInvocation(params: Partial<Parameters<typeof createQaEvidenceInvocation>[0]> = {}) {
  return createQaEvidenceInvocation({ scenarios: [scenario], channel: null, launch, ...params });
}

type Invocation = ReturnType<typeof createInvocation>;
function complete(owner: Invocation, id: string, status: "pass" | "fail") {
  owner.complete(id, { status, entries: [entry(status)] });
}
function record(owner: Invocation, status: "pass" | "fail", index = 0, retryOf?: string | null) {
  const id = owner.begin(index, retryOf);
  complete(owner, id, status);
  owner.select(index, id);
  return id;
}
function family() {
  const parent = createInvocation();
  return { parent, child: createInvocation({ anchors: parent.anchors }) };
}
function snapshot(owner: Invocation) {
  return owner.snapshot(snapshotOptions);
}
function outcomes(summary: ReturnType<typeof snapshot>) {
  return projectQaEvidenceScenarioOutcomes(summary).map((item) => item.status);
}
function importSelected(parent: Invocation, child: Invocation, id: string | null) {
  parent.importChild(0, snapshot(child));
  parent.select(0, id);
}

describe("evidence invocation owner", () => {
  it("isolates continuation, imported child evidence, and returned observations", () => {
    const parent = createInvocation();
    const first = record(parent, "fail");
    const continuation = parent.childInput(0);
    const child = createInvocation({ anchors: parent.anchors, continuation });
    continuation.entries[0]!.test.title = "mutated continuation";
    continuation.occurrences.find((item) => item.id === first)!.launch.source.ref = "mutated";
    const second = record(child, "pass");
    const input = snapshot(child);
    const expected = snapshot(child);
    parent.importChild(0, input);
    input.entries[1]!.result.status = "fail";
    input.occurrences.find((item) => item.id === second)!.launch.source.ref = "mutated";
    parent.select(0, second);
    expect(snapshot(parent)).toEqual(expected);
    expect(expected.entries[0]!.test.title).toBe("Synthetic check");
    expect(expected.occurrences.every((item) => item.launch.source.ref === "source-A")).toBe(true);
    const selected = parent.selectedObservation(0)!;
    selected.occurrence.launch.source.ref = "mutated output";
    selected.entries[0]!.result.status = "fail";
    const output = snapshot(parent);
    output.occurrences[0]!.parentCell!.scenarioId = "mutated output";
    expect(snapshot(parent)).toEqual(expected);
  });

  it("reconciles admitted open observations before and after child selection without rewriting history", () => {
    const { parent, child } = family();
    const comparison = child.begin(0, null);
    importSelected(parent, child, null);
    expect(parent.childInput(0).occurrences.at(-1)?.terminalStatus).toBeNull();
    const first = record(child, "pass", 0, null);
    importSelected(parent, child, first);
    child.complete(comparison, { status: "pass", entries: [{ ...entry("pass"), coverage: [] }] });
    child.select(0, comparison);
    importSelected(parent, child, comparison);
    const second = record(child, "fail", 0, null);
    importSelected(parent, child, second);
    expect(snapshot(parent)).toEqual(snapshot(child));
    const before = snapshot(parent);
    const changed = structuredClone(before);
    changed.occurrences.find((item) => item.id === comparison)!.terminalStatus = "fail";
    parent.select(0, parent.importChild(0, changed));
    expect(snapshot(parent)).toEqual(before);
  });

  it("rejects changed launch facts while completing an open child without partial admission", () => {
    const { parent, child } = family();
    const id = child.begin(0);
    importSelected(parent, child, null);
    const before = snapshot(parent);
    complete(child, id, "pass");
    child.select(0, id);
    const changed = snapshot(child);
    changed.occurrences.find((item) => item.id === id)!.launch.source.ref = "other-source";
    expect(() => parent.importChild(0, changed)).toThrow(/foreign/);
    expect(snapshot(parent)).toEqual(before);
  });

  it("continues only the captured instance and retains its retry history", () => {
    const parent = createInvocation({ scenarios: [scenario, scenario] });
    const first = record(parent, "fail", 1);
    const before = snapshot(parent);
    const continuation = parent.childInput(1);
    const child = createInvocation({ anchors: [parent.anchors[1]!], continuation });
    const second = record(child, "pass");
    const childResult = snapshot(child);
    expect(parent.importChild(1, childResult)).toBe(second);
    expect(snapshot(parent)).toEqual(before);
    parent.select(1, second);
    const final = snapshot(parent);
    expect(final.occurrences.find((item) => item.id === first)).toEqual(
      before.occurrences.find((item) => item.id === first),
    );
    expect(final.occurrences.find((item) => item.id === second)?.retryOf).toBe(first);
    expect(outcomes(final)).toEqual([null, "pass"]);
    expect(getEffectiveQaEvidenceEntries(final).map((row) => row.result.status)).toEqual(["pass"]);
    expect(final.entries).toHaveLength(2);
    expect(continuation.entries).toEqual(before.entries);
  });

  it("rejects publication when a selected failure would become ineffective", () => {
    const parent = createInvocation();
    const first = record(parent, "fail", 0);
    const before = snapshot(parent);
    const child = createInvocation({ anchors: parent.anchors, continuation: before });
    record(child, "pass", 0);
    const input = snapshot(child);
    parent.importChild(0, input);
    parent.select(0, first);
    expect(() => snapshot(parent)).toThrow(/selected observation is ineffective/);
  });

  it("accepts an identical pending replay after another instance appends and retains insertion order", () => {
    const parent = createInvocation({ scenarios: [scenario, scenario] });
    const child = createInvocation({ anchors: [parent.anchors[0]!] });
    const first = record(child, "pass", 0);
    const input = snapshot(child);
    parent.importChild(0, input);
    const other = record(parent, "fail", 1);
    const beforeReplay = snapshot(parent);
    expect(parent.importChild(0, input)).toBe(first);
    expect(snapshot(parent)).toEqual(beforeReplay);
    parent.select(0, first);
    const final = snapshot(parent);
    expect(final.entries.map((row) => row.binding.occurrenceId)).toEqual([first, other]);
    expect(outcomes(final)).toEqual(["pass", "fail"]);
  });

  it.each(["pass", "fail"] as const)(
    "continues a nonpassing retry without forking for %s",
    (status) => {
      let owner = createInvocation();
      const ids: string[] = [];
      for (const nextStatus of ["fail", "fail", status] as const) {
        const id = owner.begin(0);
        ids.push(id);
        owner.complete(id, { status: nextStatus, entries: [entry(nextStatus)] });
        owner.select(0, id);
        const continuation = owner.snapshot(snapshotOptions);
        owner = createInvocation({
          anchors: owner.anchors,
          continuation,
        });
      }
      const final = owner.snapshot(snapshotOptions);
      expect(final.occurrences.slice(1).map((item) => item.retryOf)).toEqual([
        null,
        ids[0],
        ids[1],
      ]);
      expect(projectQaEvidenceScenarioOutcomes(final)[0]).toMatchObject({
        occurrenceId: status === "pass" ? ids[2] : ids[0],
        status,
      });
      expect(getEffectiveQaEvidenceEntries(final).map((row) => row.result.status)).toEqual([
        status,
      ]);
    },
  );

  it("rejects continued scheduling changes and retains captured rows during continuation", () => {
    const parent = createInvocation();
    record(parent, "fail", 0);
    const before = snapshot(parent);
    expect(() =>
      createInvocation({
        launch: { ...launch, proofClass: "live-provider" },
        anchors: parent.anchors,
        continuation: before,
      }),
    ).toThrow(/scheduling/);
    expect(() =>
      createInvocation({
        scenarios: [scenario, scenario],
        anchors: parent.anchors,
        continuation: before,
      }),
    ).toThrow(/count/);
    const child = createInvocation({ anchors: parent.anchors, continuation: before });
    const retry = record(child, "pass", 0);
    const changed = snapshot(child);
    changed.entries[0]!.test.title = "rewritten history";
    parent.importChild(0, changed);
    expect(snapshot(parent)).toEqual(before);
    parent.select(0, retry);
    expect(snapshot(parent).entries[0]?.test.title).toBe("Synthetic check");
  });

  it("captures explicit assertion declarations before launch without using later catalog mutations", () => {
    const assertion = {
      id: "observed-reply",
      meaning: "the reply reached the selected account",
      coverage: entry("pass").coverage,
    };
    const declarations = [structuredClone(assertion)];
    const invocation = createInvocation({
      scenarios: [{ ...scenario, assertions: declarations }],
    });
    declarations[0]!.meaning = "changed after scheduling";
    const id = invocation.begin(0);
    invocation.complete(id, {
      status: "pass",
      entries: [
        {
          ...entry("pass"),
          binding: { occurrenceId: id, assertionId: "observed-reply", receiptId: null },
          effective: true,
        },
      ],
    });
    invocation.select(0, id);
    expect(snapshot(invocation).occurrences.at(-1)?.assertions).toEqual([assertion]);
  });

  it("captures scheduling before execution and never reconstructs assertions from v2 labels", () => {
    const mutableLaunch = structuredClone(launch);
    const invocation = createInvocation({
      scenarios: [scenario, scenario],
      launch: mutableLaunch,
    });
    mutableLaunch.source.ref = "replaced-after-scheduling";
    const attempt = invocation.begin(1);
    invocation.complete(attempt, { status: "pass", entries: [entry("pass")] });
    invocation.select(1, attempt);
    const evidence = invocation.snapshot(snapshotOptions);
    expect(projectQaEvidenceScenarioOutcomes(evidence).map((outcome) => outcome.status)).toEqual([
      null,
      "pass",
    ]);
    expect(
      evidence.occurrences.every((occurrence) => occurrence.launch.source.ref === "source-A"),
    ).toBe(true);
    expect(evidence.entries[0]?.binding).toEqual({
      occurrenceId: attempt,
      assertionId: null,
      receiptId: null,
    });
    expect(evidence.occurrences.at(-1)?.assertions).toBeNull();
    expect(new Set(evidence.occurrences.map((occurrence) => occurrence.id)).size).toBe(3);
  });

  it("retains a passing child while only the parent selects its missing-result failure", () => {
    const { parent, child } = family();
    const childAttempt = record(child, "pass", 0);
    expect(parent.importChild(0, snapshot(child))).toBe(childAttempt);
    expect(projectQaEvidenceScenarioOutcomes(snapshot(parent))[0]?.status).toBeNull();
    const missingResult = parent.begin(0);
    parent.complete(missingResult, {
      status: "fail",
      entries: [{ ...entry("fail"), coverage: [] }],
    });
    parent.select(0, missingResult);
    const final = snapshot(parent);
    expect(projectQaEvidenceScenarioOutcomes(final)[0]).toMatchObject({
      occurrenceId: missingResult,
      status: "fail",
    });
    expect(final.entries.map((row) => row.result.status)).toEqual(["pass", "fail"]);
    expect(() => parent.complete(missingResult, { status: "fail", entries: [] })).toThrow(
      /only once/,
    );
    expect(parent.importChild(0, snapshot(child))).toBe(childAttempt);
    expect(snapshot(parent)).toEqual(final);
  });

  it("rejects publication of an explicit retry of a blocked observation", () => {
    const status = "blocked";
    const invocation = createInvocation();
    const first = invocation.begin(0, null);
    invocation.complete(first, {
      status,
      entries: [{ ...entry("pass"), result: { status } }],
    });
    invocation.select(0, first);
    const second = invocation.begin(0, first);
    complete(invocation, second, "pass");
    invocation.select(0, second);
    expect(() => snapshot(invocation)).toThrow(/retry selection/);
  });

  it.each([
    ["source", { ref: "other-source", integrity: "tree-A" }],
    ["proofClass", "live-provider"],
  ] as const)(
    "rejects child %s substitution instead of combining unrelated facts",
    (dimension, replacement) => {
      const { parent, child } = family();
      const id = record(child, "pass");
      const evidence = snapshot(child);
      const observation = evidence.occurrences.find((candidate) => candidate.id === id)!;
      Object.assign(observation.launch, { [dimension]: replacement });
      expect(() => parent.importChild(0, evidence)).toThrow(/foreign or repeated/);
      expect(snapshot(parent).entries).toEqual([]);
    },
  );
});
