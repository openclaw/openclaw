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
function row(status: QaEvidenceStatus): QaEvidenceSummaryEntry {
  return {
    test: { id: "repeated", kind: "script-test", title: "Retained check" },
    coverage: [],
    result: { status },
  };
}
function owner() {
  return createQaEvidenceInvocation({ scenarios: [scenario], channel: null, launch });
}
function bundle(status: QaEvidenceStatus) {
  const child = createQaEvidenceInvocation({
    scenarios: [scenario, scenario],
    channel: null,
    launch: { ...launch, source: { ref: "child-source", integrity: "child-tree" } },
  });
  const id = child.begin(0);
  child.complete(id, { status, entries: [row(status)] });
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
) {
  const id = parent.begin(0, retryOf);
  parent.complete(id, {
    status,
    entries: [row(status)],
    receipts: [receipt(id)],
    childEvidence,
  });
  parent.select(0, id);
  return id;
}

describe("retained child evidence ownership", () => {
  it.each(["full", "slim"] as const)(
    "intersects nested coverage caps without promoting or rewriting %s child claims",
    (evidenceMode) => {
      const child = bundle("pass");
      child.entries[0]!.coverage = [
        { id: "qa.coverage", role: "primary" },
        { id: "qa.reporting", role: "secondary" },
        { id: "qa.diagnostic", role: "diagnostic" },
        { id: "other.claim", role: "primary" },
      ];
      const original = structuredClone(child);
      function capture(input: typeof child, childCoverage?: QaEvidenceOccurrence["childCoverage"]) {
        const parent = owner();
        const id = parent.begin(0);
        parent.complete(id, {
          status: "pass",
          entries: [row("pass")],
          childEvidence: input,
          childCoverage,
          receipts: [receipt(id)],
        });
        parent.select(0, id);
        return parent.snapshot({ ...options, evidenceMode });
      }
      const inner = capture(child, [
        { id: "qa.coverage", role: "secondary" },
        { id: "qa.reporting", role: "primary" },
        { id: "qa.diagnostic", role: "primary" },
      ]);
      const summary = capture(inner, [
        { id: "qa.coverage", role: "primary" },
        { id: "qa.reporting", role: "primary" },
        { id: "qa.diagnostic", role: "primary" },
        { id: "other.claim", role: "primary" },
      ]);
      const entry = summary.entries[0]!;
      const containment = resolveQaEvidenceContainment(summary.occurrences, summary.entries);
      expect(containment.projectCoverage(entry.binding.occurrenceId, entry.coverage)).toEqual([
        { id: "qa.coverage", role: "secondary" },
        { id: "qa.reporting", role: "secondary" },
        { id: "qa.diagnostic", role: "diagnostic" },
      ]);
      expect(entry).toEqual(original.entries[0]);
      expect(getEffectiveQaEvidenceEntries(summary)[0]).toBe(entry);
      const empty = capture(child, []);
      expect(
        resolveQaEvidenceContainment(empty.occurrences, empty.entries).projectCoverage(
          entry.binding.occurrenceId,
          entry.coverage,
        ),
      ).toEqual([]);
      const historical = capture(child);
      expect(
        resolveQaEvidenceContainment(historical.occurrences, historical.entries).projectCoverage(
          entry.binding.occurrenceId,
          entry.coverage,
        ),
      ).toBe(entry.coverage);
      expect(
        resolveQaEvidenceContainment(child.occurrences, child.entries).projectCoverage(
          entry.binding.occurrenceId,
          entry.coverage,
        ),
      ).toBe(entry.coverage);
      expect(child).toEqual(original);
    },
  );

  it("admits a coverage cap once with open completion and rejects later rewrites atomically", () => {
    const parent = owner();
    const shared = createQaEvidenceInvocation({
      scenarios: [scenario],
      channel: null,
      launch,
      anchors: parent.anchors,
    });
    const id = shared.begin(0);
    parent.importChild(0, shared.snapshot(options));
    parent.select(0, null);
    const open = parent.snapshot(options);
    expect(() =>
      parent.complete(id, {
        status: "pass",
        entries: [row("pass")],
        childCoverage: [],
      }),
    ).toThrow(/membership/);
    expect(parent.snapshot(options)).toEqual(open);
    shared.complete(id, {
      status: "pass",
      entries: [row("pass")],
      childEvidence: bundle("pass"),
      childCoverage: [{ id: "qa.coverage", role: "secondary" }],
      receipts: [receipt(id)],
    });
    shared.select(0, id);
    parent.importChild(0, shared.snapshot(options));
    parent.select(0, id);
    const completed = parent.snapshot(options);
    expect(completed).toEqual(shared.snapshot(options));
    const changed = structuredClone(completed);
    changed.occurrences.find((item) => item.id === id)!.childCoverage = [];
    expect(() => parent.importChild(0, changed)).toThrow(/completed or immutable/);
    expect(parent.snapshot(options)).toEqual(completed);
  });

  it.each(["full", "slim"] as const)(
    "preserves %s child identities, unresolved schedule and local pointers behind one outer result",
    (evidenceMode) => {
      const child = bundle("pass");
      const before = structuredClone(child);
      const parent = owner();
      const id = finish(parent, child, "pass");
      const summary = parent.snapshot({ ...options, evidenceMode });
      expect(
        summary.occurrences.filter((item) =>
          child.occurrences.some((member) => member.id === item.id),
        ),
      ).toEqual(child.occurrences);
      expect(summary.entries.slice(0, child.entries.length)).toEqual(child.entries);
      expect(projectQaEvidenceScenarioOutcomes(summary)).toEqual([
        {
          scenarioId: scenario.id,
          scenarioInstanceId: parent.anchors[0]!.id,
          occurrenceId: id,
          status: "pass",
        },
      ]);
      expect(projectQaEvidenceScenarioOutcomes(child).map((item) => item.status)).toEqual([
        "pass",
        null,
      ]);
      expect(child).toEqual(before);
      const input = parent.childInput(0);
      expect(input).toEqual(parent.snapshot({ generatedAt: input.generatedAt }));
    },
  );

  it.each(["pass", "fail", "blocked", "skipped"] as const)(
    "applies enclosing %s retry selection without rewriting either child bundle",
    (status) => {
      const parent = owner();
      const first = bundle("fail");
      const firstId = finish(parent, first, "fail");
      const independent = parent.begin(0, null);
      parent.complete(independent, { status: "fail", entries: [row("fail")] });
      parent.select(0, firstId);
      const second = bundle(status);
      const nextId = finish(parent, second, status);
      const summary = parent.snapshot(options);
      expect(projectQaEvidenceScenarioOutcomes(summary)[0]).toMatchObject({
        occurrenceId: status === "pass" ? nextId : firstId,
        status: status === "pass" ? "pass" : "fail",
      });
      for (const child of [first, second]) {
        for (const occurrence of child.occurrences) {
          expect(summary.occurrences.find((item) => item.id === occurrence.id)).toEqual(occurrence);
        }
        for (const entry of child.entries) {
          expect(
            summary.entries.find(
              (item) => item.binding.occurrenceId === entry.binding.occurrenceId,
            ),
          ).toEqual(entry);
        }
      }
      const active = getEffectiveQaEvidenceEntries(summary);
      expect(active.map((entry) => entry.result.status)).toEqual(
        status === "pass" ? ["fail", "pass", "pass"] : ["fail", "fail", "fail"],
      );
      const restored = createQaEvidenceInvocation({
        scenarios: [scenario],
        channel: null,
        launch,
        anchors: parent.anchors,
        continuation: summary,
      });
      expect(restored.snapshot(options)).toEqual(summary);
      const outer = createQaEvidenceInvocation({
        scenarios: [scenario],
        channel: null,
        launch,
        anchors: owner().anchors,
      });
      expect(() => outer.importChild(0, summary)).toThrow(/scheduling/);
    },
  );

  it("retains nested direct membership through shared-anchor import and continuation", () => {
    const parent = owner();
    const shared = createQaEvidenceInvocation({
      scenarios: [scenario],
      channel: null,
      launch,
      anchors: parent.anchors,
    });
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
    expect(() =>
      parent.complete(next, {
        status: "pass",
        entries: [row("pass")],
        receipts: [receipt(next)],
        childEvidence: child,
      }),
    ).toThrow(/overlaps/);
    expect(parent.snapshot(options)).toEqual(before);
    const malformed = structuredClone(child);
    malformed.occurrences[0]!.childOccurrenceIds = ["absent"];
    expect(() =>
      parent.complete(next, {
        status: "pass",
        entries: [row("pass")],
        receipts: [receipt(next)],
        childEvidence: malformed,
      }),
    ).toThrow();
    expect(parent.snapshot(options)).toEqual(before);
  });

  it("rejects rewritten child-local activity on a later shared snapshot", () => {
    const parent = owner();
    const shared = createQaEvidenceInvocation({
      scenarios: [scenario],
      channel: null,
      launch,
      anchors: parent.anchors,
    });
    const child = owner();
    const selected = child.begin(0);
    child.complete(selected, { status: "pass", entries: [row("pass")] });
    child.select(0, selected);
    const diagnostic = child.begin(0, null);
    child.complete(diagnostic, { status: "fail", entries: [row("fail")] });
    const command = finish(shared, child.snapshot(options), "fail");
    parent.importChild(0, shared.snapshot(options));
    parent.select(0, command);
    const before = parent.snapshot(options);
    const rewritten = structuredClone(before);
    rewritten.entries.find((entry) => entry.binding.occurrenceId === diagnostic)!.effective = false;
    expect(validateQaEvidenceSummaryJson(rewritten)).toEqual(rewritten);
    expect(() => parent.importChild(0, rewritten)).toThrow(/retained bundle selection/);
    expect(parent.snapshot(options)).toEqual(before);
  });

  it("rejects completion of an open observation already captured in an immutable bundle", () => {
    const parent = owner();
    const shared = createQaEvidenceInvocation({
      scenarios: [scenario],
      channel: null,
      launch,
      anchors: parent.anchors,
    });
    const child = owner();
    const open = child.begin(0);
    const command = finish(shared, child.snapshot(options), "fail");
    parent.importChild(0, shared.snapshot(options));
    parent.select(0, command);
    const before = parent.snapshot(options);
    expect(() => parent.complete(open, { status: "pass", entries: [row("pass")] })).toThrow(
      /captured child/,
    );
    expect(parent.snapshot(options)).toEqual(before);
    expect(parent.childInput(0).occurrences).toEqual(before.occurrences);
    child.complete(open, { status: "pass", entries: [row("pass")], receipts: [receipt("later")] });
    const completion = child.snapshot(options);
    const rewritten = structuredClone(before);
    rewritten.occurrences = rewritten.occurrences.map((item) =>
      item.id === open ? completion.occurrences.find((candidate) => candidate.id === open)! : item,
    );
    rewritten.entries.push(...completion.entries);
    expect(validateQaEvidenceSummaryJson(rewritten)).toEqual(rewritten);
    expect(() => parent.importChild(0, rewritten)).toThrow(/completed or immutable/);
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
