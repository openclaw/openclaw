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

describe("evidence invocation owner", () => {
  it("reconciles admitted open observations before and after child selection without rewriting history", () => {
    const parent = createInvocation();
    const child = createInvocation({ anchors: parent.anchors });
    const comparison = child.begin(0, null);
    parent.importChild(0, child.snapshot(snapshotOptions));
    parent.select(0, null);
    expect(parent.childInput(0).occurrences.at(-1)?.terminalStatus).toBeNull();
    const first = child.begin(0, null);
    child.complete(first, { status: "pass", entries: [entry("pass")] });
    child.select(0, first);
    parent.importChild(0, child.snapshot(snapshotOptions));
    parent.select(0, first);
    child.complete(comparison, { status: "pass", entries: [{ ...entry("pass"), coverage: [] }] });
    child.select(0, comparison);
    parent.importChild(0, child.snapshot(snapshotOptions));
    parent.select(0, comparison);
    const second = child.begin(0, null);
    child.complete(second, { status: "fail", entries: [entry("fail")] });
    child.select(0, second);
    parent.importChild(0, child.snapshot(snapshotOptions));
    parent.select(0, second);
    expect(parent.snapshot(snapshotOptions)).toEqual(child.snapshot(snapshotOptions));
    const before = parent.snapshot(snapshotOptions);
    const changed = structuredClone(before);
    changed.occurrences.find((item) => item.id === comparison)!.terminalStatus = "fail";
    expect(() => parent.importChild(0, changed)).toThrow(/completed or immutable/);
    expect(parent.snapshot(snapshotOptions)).toEqual(before);
  });

  it("rejects changed launch facts while completing an open child without partial admission", () => {
    const parent = createInvocation();
    const child = createInvocation({ anchors: parent.anchors });
    const id = child.begin(0);
    parent.importChild(0, child.snapshot(snapshotOptions));
    parent.select(0, null);
    const before = parent.snapshot(snapshotOptions);
    child.complete(id, { status: "pass", entries: [entry("pass")] });
    child.select(0, id);
    const changed = child.snapshot(snapshotOptions);
    changed.occurrences.find((item) => item.id === id)!.launch.source.ref = "other-source";
    expect(() => parent.importChild(0, changed)).toThrow(/immutable/);
    expect(parent.snapshot(snapshotOptions)).toEqual(before);
  });

  it("continues only the captured instance and retains its retry history", () => {
    const parent = createInvocation({ scenarios: [scenario, scenario] });
    const first = parent.begin(1);
    parent.complete(first, { status: "fail", entries: [entry("fail")] });
    parent.select(1, first);
    const before = parent.snapshot(snapshotOptions);
    const continuation = parent.childInput(1);
    const child = createInvocation({
      anchors: [parent.anchors[1]!],
      continuation,
    });
    const second = child.begin(0);
    child.complete(second, { status: "pass", entries: [entry("pass")] });
    const selected = child.select(0, second);
    const childResult = child.snapshot(snapshotOptions);
    expect(parent.importChild(1, childResult)).toBe(selected);
    expect(parent.snapshot(snapshotOptions)).toEqual(before);
    parent.select(1, selected);
    const final = parent.snapshot(snapshotOptions);
    expect(final.occurrences.find((item) => item.id === first)).toEqual(
      before.occurrences.find((item) => item.id === first),
    );
    expect(final.occurrences.find((item) => item.id === second)?.retryOf).toBe(first);
    expect(projectQaEvidenceScenarioOutcomes(final).map((item) => item.status)).toEqual([
      null,
      "pass",
    ]);
    expect(getEffectiveQaEvidenceEntries(final).map((row) => row.result.status)).toEqual(["pass"]);
    expect(final.entries).toHaveLength(2);
    expect(continuation.entries).toEqual(before.entries);
  });

  it("rejects publication when a selected failure would become ineffective", () => {
    const parent = createInvocation();
    const first = parent.begin(0);
    parent.complete(first, { status: "fail", entries: [entry("fail")] });
    parent.select(0, first);
    const before = parent.snapshot(snapshotOptions);
    const child = createInvocation({
      anchors: parent.anchors,
      continuation: before,
    });
    const retry = child.begin(0);
    child.complete(retry, { status: "pass", entries: [entry("pass")] });
    child.select(0, retry);
    const input = child.snapshot(snapshotOptions);
    parent.importChild(0, input);
    expect(() => parent.select(0, first)).toThrow(/selected observation is ineffective/);
    expect(() => parent.snapshot(snapshotOptions)).toThrow(/selected observation is ineffective/);
  });

  it("accepts an identical pending replay after another instance appends and retains insertion order", () => {
    const parent = createInvocation({ scenarios: [scenario, scenario] });
    const child = createInvocation({ anchors: [parent.anchors[0]!] });
    const first = child.begin(0);
    child.complete(first, { status: "pass", entries: [entry("pass")] });
    child.select(0, first);
    const input = child.snapshot(snapshotOptions);
    parent.importChild(0, input);
    const other = parent.begin(1);
    parent.complete(other, { status: "fail", entries: [entry("fail")] });
    parent.select(1, other);
    const beforeReplay = parent.snapshot(snapshotOptions);
    expect(parent.importChild(0, input)).toBe(first);
    expect(parent.snapshot(snapshotOptions)).toEqual(beforeReplay);
    parent.select(0, first);
    const final = parent.snapshot(snapshotOptions);
    expect(final.entries.map((row) => row.binding.occurrenceId)).toEqual([first, other]);
    expect(projectQaEvidenceScenarioOutcomes(final).map((item) => item.status)).toEqual([
      "pass",
      "fail",
    ]);
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

  it("rejects continued scheduling and immutable row substitution without partial import", () => {
    const parent = createInvocation();
    const first = parent.begin(0);
    parent.complete(first, { status: "fail", entries: [entry("fail")] });
    parent.select(0, first);
    const before = parent.snapshot(snapshotOptions);
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
    const child = createInvocation({
      anchors: parent.anchors,
      continuation: before,
    });
    const retry = child.begin(0);
    child.complete(retry, { status: "pass", entries: [entry("pass")] });
    child.select(0, retry);
    const changed = child.snapshot(snapshotOptions);
    changed.entries[0]!.test.title = "rewritten history";
    expect(() => parent.importChild(0, changed)).toThrow(/existing observation/);
    expect(parent.snapshot(snapshotOptions)).toEqual(before);
  });

  it("captures explicit assertion declarations before launch without using later catalog mutations", () => {
    const declarations = [
      {
        id: "observed-reply",
        meaning: "the reply reached the selected account",
        coverage: entry("pass").coverage,
      },
    ];
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
    expect(invocation.snapshot(snapshotOptions).occurrences.at(-1)?.assertions).toEqual([
      {
        id: "observed-reply",
        meaning: "the reply reached the selected account",
        coverage: entry("pass").coverage,
      },
    ]);
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
    const parent = createInvocation();
    const child = createInvocation({ anchors: parent.anchors });
    const childAttempt = child.begin(0);
    child.complete(childAttempt, { status: "pass", entries: [entry("pass")] });
    child.select(0, childAttempt);
    expect(parent.importChild(0, child.snapshot(snapshotOptions))).toBe(childAttempt);
    expect(
      projectQaEvidenceScenarioOutcomes(parent.snapshot(snapshotOptions))[0]?.status,
    ).toBeNull();
    const missingResult = parent.begin(0);
    parent.complete(missingResult, {
      status: "fail",
      entries: [{ ...entry("fail"), coverage: [] }],
    });
    parent.select(0, missingResult);
    const final = parent.snapshot(snapshotOptions);
    expect(projectQaEvidenceScenarioOutcomes(final)[0]).toMatchObject({
      occurrenceId: missingResult,
      status: "fail",
    });
    expect(final.entries.map((row) => row.result.status)).toEqual(["pass", "fail"]);
    expect(() => parent.complete(missingResult, { status: "fail", entries: [] })).toThrow(
      /only once/,
    );
    expect(parent.importChild(0, child.snapshot(snapshotOptions))).toBe(childAttempt);
    expect(parent.snapshot(snapshotOptions)).toEqual(final);
  });

  it("rejects an explicit retry of a blocked observation", () => {
    const status = "blocked";
    const invocation = createInvocation();
    const first = invocation.begin(0, null);
    invocation.complete(first, {
      status,
      entries: [{ ...entry("pass"), result: { status } }],
    });
    invocation.select(0, first);
    const second = invocation.begin(0, first);
    invocation.complete(second, { status: "pass", entries: [entry("pass")] });
    expect(() => invocation.select(0, second)).toThrow(/retry selection/);
  });

  it.each([
    ["source", { ref: "other-source", integrity: "tree-A" }],
    ["proofClass", "live-provider"],
  ] as const)(
    "rejects child %s substitution instead of combining unrelated facts",
    (dimension, replacement) => {
      const parent = createInvocation();
      const child = createInvocation({ anchors: parent.anchors });
      const id = child.begin(0);
      child.complete(id, { status: "pass", entries: [entry("pass")] });
      child.select(0, id);
      const evidence = child.snapshot(snapshotOptions);
      const observation = evidence.occurrences.find((candidate) => candidate.id === id)!;
      Object.assign(observation.launch, { [dimension]: replacement });
      expect(() => parent.importChild(0, evidence)).toThrow(/foreign or repeated/);
      expect(parent.snapshot(snapshotOptions).entries).toEqual([]);
    },
  );
});
