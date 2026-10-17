import { describe, expect, it } from "vitest";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import { resolveQaEvidenceContainment } from "./evidence-summary-schema.js";
import {
  getEffectiveQaEvidenceEntries,
  projectQaEvidenceScenarioOutcomes,
  validateQaEvidenceSummaryJson,
  type QaEvidenceIdentity,
  type QaEvidenceOccurrence,
  type QaEvidenceStatus,
  type QaEvidenceSummaryEntry,
} from "./evidence-summary.js";

const launch: QaEvidenceIdentity = {
  source: { ref: "fixture-source", integrity: "fixture-tree" },
  runtime: { id: null, version: null },
  package: null,
  protocol: null,
  accountRef: null,
  proofClass: null,
};
const scenario = { id: "repeated", execution: { kind: "script" as const } };
const options = { generatedAt: "2026-09-13T00:00:00Z" };
function family() {
  const parent = owner();
  return { parent, shared: owner({ anchors: parent.anchors }), child: owner() };
}
function claims(...pairs: [string, "primary" | "secondary" | "diagnostic"][]) {
  return pairs.map(([id, role]) => ({ id, role }));
}
function row(status: QaEvidenceStatus): QaEvidenceSummaryEntry {
  return {
    test: { id: "repeated", kind: "script-test", title: "Retained check" },
    coverage: [],
    result: { status },
  };
}
function owner(params: Partial<Parameters<typeof createQaEvidenceInvocation>[0]> = {}) {
  return createQaEvidenceInvocation({ scenarios: [scenario], channel: null, launch, ...params });
}
function bundle(status: QaEvidenceStatus) {
  const child = owner({
    scenarios: [scenario, scenario],
    launch: { ...launch, source: { ref: "child-source", integrity: "child-tree" } },
  });
  const id = child.begin(0);
  complete(child, id, status);
  child.select(0, id);
  return child.snapshot(options);
}
function receipt(id: string) {
  return {
    id: `${id}:bundle`,
    phase: "prepared" as const,
    identity: launch,
    artifact: {
      kind: "producer-evidence",
      path: `${id}/qa-evidence.json`,
      source: "script",
      sha256: "a".repeat(64),
    },
  };
}
function finish(
  parent: ReturnType<typeof owner>,
  childEvidence: ReturnType<typeof bundle>,
  status: QaEvidenceStatus,
  retryOf?: string | null,
  childCoverage?: QaEvidenceOccurrence["childCoverage"],
) {
  const id = parent.begin(0, retryOf);
  complete(parent, id, status, { receipts: [receipt(id)], childEvidence, childCoverage });
  parent.select(0, id);
  return id;
}
type Owner = ReturnType<typeof owner>;
function complete(
  invocation: Owner,
  id: string,
  status: QaEvidenceStatus,
  extra: Partial<Parameters<Owner["complete"]>[1]> = {},
) {
  invocation.complete(id, { status, entries: [row(status)], ...extra });
}
function importSelected(parent: Owner, shared: Owner) {
  parent.select(0, parent.importChild(0, shared.snapshot(options)));
}
function capture(child: ReturnType<typeof bundle>, cap?: QaEvidenceOccurrence["childCoverage"]) {
  const parent = owner();
  finish(parent, child, "pass", undefined, cap);
  return parent.snapshot(options);
}

function projectCoverage(summary: ReturnType<typeof bundle>, entry = summary.entries[0]!) {
  return resolveQaEvidenceContainment(summary.occurrences, summary.entries).projectCoverage(
    entry.binding.occurrenceId,
    entry.coverage,
  );
}

describe("retained child evidence ownership", () => {
  it("intersects nested coverage caps without promoting or rewriting child claims", () => {
    const child = bundle("pass");
    child.entries[0]!.coverage = claims(
      ["cap", "primary"],
      ["report", "secondary"],
      ["diag", "diagnostic"],
      ["other", "primary"],
    );
    const original = structuredClone(child);
    const inner = capture(
      child,
      claims(["cap", "secondary"], ["report", "primary"], ["diag", "primary"]),
    );
    const summary = capture(
      inner,
      claims(["cap", "primary"], ["report", "primary"], ["diag", "primary"], ["other", "primary"]),
    );
    const entry = summary.entries[0]!;
    expect(projectCoverage(summary, entry)).toEqual(
      claims(["cap", "secondary"], ["report", "secondary"], ["diag", "diagnostic"]),
    );
    expect(entry).toEqual(original.entries[0]);
    expect(getEffectiveQaEvidenceEntries(summary)[0]).toBe(entry);
    const empty = capture(child, []);
    expect(projectCoverage(empty, entry)).toEqual([]);
    const historical = capture(child);
    expect(projectCoverage(historical, entry)).toBe(entry.coverage);
    expect(projectCoverage(child, entry)).toBe(entry.coverage);
    expect(child).toEqual(original);
  });

  it("captures completed child bundles once without admitting later rewrites", () => {
    const { parent, shared } = family();
    const id = shared.begin(0);
    importSelected(parent, shared);
    complete(shared, id, "pass", {
      childEvidence: bundle("pass"),
      childCoverage: [{ id: "qa.coverage", role: "secondary" }],
      receipts: [receipt(id)],
    });
    shared.select(0, id);
    importSelected(parent, shared);
    const completed = parent.snapshot(options);
    expect(completed).toEqual(shared.snapshot(options));
    const changed = structuredClone(completed);
    changed.occurrences.find((item) => item.id === id)!.childCoverage = [];
    parent.select(0, parent.importChild(0, changed));
    expect(parent.snapshot(options)).toEqual(completed);

    const appended = bundle("pass");
    appended.entries[0]!.coverage = [{ id: "qa.unowned", role: "primary" }];
    changed.occurrences
      .find((item) => item.id === id)!
      .childOccurrenceIds!.push(...appended.occurrences.map((item) => item.id));
    changed.occurrences.push(...appended.occurrences);
    changed.entries.push(...appended.entries);
    parent.select(0, parent.importChild(0, changed));
    const final = parent.snapshot(options);
    expect(
      getEffectiveQaEvidenceEntries(final).flatMap((entry) => entry.coverage),
    ).not.toContainEqual({ id: "qa.unowned", role: "primary" });
    expect(final).toEqual(completed);
  });

  it.each(["pass", "fail"] as const)(
    "applies enclosing %s retry selection without rewriting either child bundle",
    (status) => {
      const parent = owner();
      const first = bundle("fail");
      const firstId = finish(parent, first, "fail");
      const independent = parent.begin(0, null);
      complete(parent, independent, "fail");
      parent.select(0, firstId);
      const second = bundle(status);
      const nextId = finish(parent, second, status);
      const summary = parent.snapshot(options);
      expect(projectQaEvidenceScenarioOutcomes(summary)).toEqual([
        {
          scenarioId: scenario.id,
          scenarioInstanceId: parent.anchors[0]!.id,
          occurrenceId: status === "pass" ? nextId : firstId,
          status,
        },
      ]);
      for (const child of [first, second]) {
        expect(summary.occurrences).toEqual(expect.arrayContaining(child.occurrences));
        expect(summary.entries).toEqual(expect.arrayContaining(child.entries));
      }
      const active = getEffectiveQaEvidenceEntries(summary);
      expect(active.map((entry) => entry.result.status)).toEqual(
        status === "pass" ? ["fail", "pass", "pass"] : ["fail", "fail", "fail"],
      );
      const restored = owner({ anchors: parent.anchors, continuation: summary });
      expect(restored.snapshot(options)).toEqual(summary);
      const outer = owner({ anchors: owner().anchors });
      expect(() => outer.importChild(0, summary)).toThrow(/scheduling/);
    },
  );

  it("retains nested direct membership through shared-anchor import and continuation", () => {
    const parent = owner();
    const shared = owner({ anchors: parent.anchors });
    const inner = owner();
    const leaf = bundle("pass");
    finish(inner, leaf, "pass");
    const innerSummary = inner.snapshot(options);
    const command = finish(shared, innerSummary, "pass");
    const input = shared.snapshot(options);
    parent.importChild(0, input);
    parent.select(0, command);
    expect(parent.snapshot(options)).toEqual(input);
    const containment = resolveQaEvidenceContainment(input.occurrences, input.entries);
    expect(containment.rootInstances).toEqual(parent.anchors);
    const outerMembers = input.occurrences.find((item) => item.id === command)!.childOccurrenceIds!;
    expect(outerMembers).toEqual(
      innerSummary.occurrences
        .filter((item) => !leaf.occurrences.some((child) => child.id === item.id))
        .map((item) => item.id),
    );
    expect(getEffectiveQaEvidenceEntries(input)).toHaveLength(3);
  });

  it("rejects reused child IDs and malformed membership before admitting partial state", () => {
    const parent = owner();
    const child = bundle("pass");
    finish(parent, child, "pass");
    const next = parent.begin(0, null);
    const before = parent.snapshot(options);
    const completeNext = (childEvidence: typeof child) =>
      complete(parent, next, "pass", { receipts: [receipt(next)], childEvidence });
    expect(() => completeNext(child)).toThrow(/overlaps/);
    expect(parent.snapshot(options)).toEqual(before);
    const malformed = structuredClone(child);
    malformed.occurrences[0]!.childOccurrenceIds = ["absent"];
    expect(() => completeNext(malformed)).toThrow();
    expect(parent.snapshot(options)).toEqual(before);
  });

  it("retains captured child-local activity on a later shared snapshot", () => {
    const { parent, shared, child } = family();
    const selected = child.begin(0);
    complete(child, selected, "pass");
    child.select(0, selected);
    const diagnostic = child.begin(0, null);
    complete(child, diagnostic, "fail");
    finish(shared, child.snapshot(options), "fail");
    importSelected(parent, shared);
    const before = parent.snapshot(options);
    const rewritten = structuredClone(before);
    rewritten.entries.find((entry) => entry.binding.occurrenceId === diagnostic)!.effective = false;
    expect(validateQaEvidenceSummaryJson(rewritten)).toEqual(rewritten);
    parent.select(0, parent.importChild(0, rewritten));
    expect(parent.snapshot(options)).toEqual(before);
  });

  it("rejects completion of an open observation already captured in an immutable bundle", () => {
    const { parent, shared, child } = family();
    const open = child.begin(0);
    finish(shared, child.snapshot(options), "fail");
    importSelected(parent, shared);
    const before = parent.snapshot(options);
    expect(() => complete(parent, open, "pass")).toThrow(/captured child/);
    expect(parent.snapshot(options)).toEqual(before);
    expect(parent.childInput(0).occurrences).toEqual(before.occurrences);
    complete(child, open, "pass", { receipts: [receipt("later")] });
    const completion = child.snapshot(options);
    const rewritten = structuredClone(before);
    rewritten.occurrences = rewritten.occurrences.map((item) =>
      item.id === open ? completion.occurrences.find((candidate) => candidate.id === open)! : item,
    );
    rewritten.entries.push(...completion.entries);
    expect(validateQaEvidenceSummaryJson(rewritten)).toEqual(rewritten);
    parent.select(0, parent.importChild(0, rewritten));
    expect(parent.snapshot(options)).toEqual(before);
    expect(parent.childInput(0).occurrences).toEqual(before.occurrences);
  });

  it.each([
    "duplicate",
    "omitted",
    "receipt",
    "ambiguous-receipt",
    "cross-attempt",
    "cycle",
  ] as const)("rejects %s ownership while retaining valid standalone evidence", (failure) => {
    const parent = owner();
    const child = bundle("pass");
    const command = finish(parent, child, "pass");
    const summary = parent.snapshot(options);
    const changed = structuredClone(summary);
    const recorded = changed.occurrences.find((item) => item.id === command)!;
    if (failure === "duplicate") {
      recorded.childOccurrenceIds!.push(recorded.childOccurrenceIds![0]!);
    } else if (failure === "omitted") {
      recorded.childOccurrenceIds = recorded.childOccurrenceIds!.slice(1);
    } else if (failure === "receipt") {
      recorded.receipts = [];
    } else if (failure === "ambiguous-receipt") {
      recorded.receipts.push(receipt("another-bundle"));
    } else if (failure === "cross-attempt") {
      const second = structuredClone(recorded);
      second.id = "other-command";
      changed.occurrences.push(second);
    } else {
      const childCommand = changed.occurrences.find(
        (item) => item.scenario?.kind === "observation" && item.id !== command,
      )!;
      childCommand.childOccurrenceIds = [parent.anchors[0]!.id, command];
      childCommand.receipts = [receipt(childCommand.id)];
    }
    expect(() => validateQaEvidenceSummaryJson(changed)).toThrow();
    expect(validateQaEvidenceSummaryJson(summary)).toEqual(summary);
    expect(validateQaEvidenceSummaryJson(child)).toEqual(child);
  });
});
