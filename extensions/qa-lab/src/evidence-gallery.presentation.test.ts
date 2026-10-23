import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildQaEvidenceGalleryModel,
  resolveQaEvidenceArtifactFile,
  resolveQaEvidenceArtifactFileByIndex,
} from "./evidence-gallery.js";
import {
  createTempRepo,
  vitestArtifactEvidence,
  writeJson,
} from "./evidence-gallery.test-support.js";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import { QA_EVIDENCE_FILENAME } from "./evidence-summary.js";

function invocation(id: string) {
  return createQaEvidenceInvocation({
    scenarios: [{ id, execution: { kind: "script" } }],
    channel: null,
    launch: {
      source: { ref: null, integrity: null },
      runtime: { id: null, version: null },
      package: null,
      protocol: null,
      accountRef: null,
      proofClass: null,
    },
  });
}
function artifactEvidence(artifact: { kind: string; path: string }, id = "recorded") {
  return vitestArtifactEvidence({ id, title: id, artifact });
}

describe("evidence gallery presentation", () => {
  let repoRoot: string, outputDir: string, evidencePath: string;
  const outsideRoots: string[] = [];
  const byPath = (artifactPath: string) =>
    resolveQaEvidenceArtifactFile({ evidencePath, repoRoot, artifactPath });
  const byIndex = (entryIndex: number, artifactIndex: number) =>
    resolveQaEvidenceArtifactFileByIndex({ evidencePath, repoRoot, entryIndex, artifactIndex });
  beforeEach(async () => {
    repoRoot = await createTempRepo();
    outputDir = path.join(repoRoot, "evidence");
    evidencePath = path.join(outputDir, QA_EVIDENCE_FILENAME);
    await fs.mkdir(outputDir);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      [repoRoot, ...outsideRoots.splice(0)].map((root) =>
        fs.rm(root, { recursive: true, force: true }),
      ),
    );
  });
  it("bounds presentation reads and shares in-flight child summaries without reordering rows", async () => {
    const readFile = fs.readFile.bind(fs);
    const reads = new Map<string, number>();
    let active = 0;
    let peak = 0;
    const source = artifactEvidence({ kind: "summary", path: "unused" }, "repeated");
    const row = source.entries[0]!;
    source.entries = [];
    for (let index = 0; index < 12; index += 1) {
      const summaryPath = path.join(outputDir, `child-${index}`, "qa-suite-summary.json");
      await writeJson(summaryPath, { run: {} });
      reads.set(await fs.realpath(summaryPath), 0);
      for (let copy = 0; copy < 2; copy += 1) {
        source.entries.push({
          ...row,
          test: { ...row.test, id: `${index}:${copy}` },
          execution: {
            ...row.execution!,
            artifacts: [{ kind: "summary", path: summaryPath, source: "qa-suite" }],
          },
        });
      }
    }
    await writeJson(evidencePath, source);
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const file = args[0];
      if (typeof file !== "string" || !reads.has(file)) {
        return readFile(...args);
      }
      reads.set(file, reads.get(file)! + 1);
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });
        return await readFile(...args);
      } finally {
        active -= 1;
      }
    });
    const gallery = await buildQaEvidenceGalleryModel({ evidencePath, repoRoot });
    expect([...reads.values()]).toEqual(Array(12).fill(1));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(active).toBe(0);
    expect(gallery.entries.map((entry) => entry.id)).toEqual(
      source.entries.map((entry) => entry.test.id),
    );
    expect(gallery.counts.pass).toBe(24);
  });

  it.each(["full", "slim"] as const)(
    "projects contained suite presentation without rewriting %s rows or counts",
    async (evidenceMode) => {
      const outsideRoot = await createTempRepo("qa-gallery-outside-");
      outsideRoots.push(outsideRoot);
      const childDir = path.join(outputDir, "child");
      await fs.mkdir(childDir, { recursive: true });
      const escaped = path.join(outsideRoot, "private.json");
      await fs.writeFile(escaped, "outside roots");
      await fs.symlink(escaped, path.join(childDir, "escape.json"));
      const matrixPath = path.join(childDir, "generation", "matrix.json");
      await writeJson(matrixPath, { generation: "actual" });
      const summaryPath = path.join(childDir, "qa-suite-summary.json");
      await writeJson(summaryPath, {
        run: {
          channelCapabilityMatrixPath: "generation/matrix.json",
          channelDriverSmokePath: "escape.json",
          unrelatedPath: escaped,
        },
      });
      const source = artifactEvidence({ kind: "summary", path: "child/qa-suite-summary.json" });
      source.entries[0]!.execution!.artifacts[0]!.source = "qa-suite";
      const owner = invocation("recorded");
      const id = owner.begin(0);
      owner.complete(id, { status: "pass", entries: source.entries });
      owner.select(0, id);
      const evidence = owner.snapshot({ generatedAt: source.generatedAt, evidenceMode });
      await writeJson(evidencePath, evidence);
      const bytes = await fs.readFile(evidencePath);
      const gallery = await buildQaEvidenceGalleryModel({ evidencePath, repoRoot });
      expect(gallery.counts).toEqual({ pass: 1, fail: 0, blocked: 0, skipped: 0 });
      expect(gallery.entries[0]!.effective).toBe(true);
      if (evidenceMode === "full") {
        expect(gallery.entries[0]!.artifacts.map((artifact) => artifact.kind)).toEqual([
          "summary",
          "channel-capability-matrix",
        ]);
        const indexed = await byIndex(0, 1);
        const declared = await byPath(matrixPath);
        expect(await fs.readFile(indexed)).toEqual(await fs.readFile(declared));
      } else {
        expect(gallery.entries[0]!.artifacts).toEqual([]);
        expect(evidence.entries[0]!.execution).toBeUndefined();
      }
      await expect(byPath(escaped)).rejects.toThrow("not found");
      expect(await fs.readFile(evidencePath)).toEqual(bytes);
    },
  );

  it("keeps duplicate labels and raw artifact indices while counting only the selected retry", async () => {
    const owner = invocation("same-label");
    let prior: string | null = null;
    for (const [index, status] of (["fail", "pass"] as const).entries()) {
      const occurrenceId = owner.begin(0, prior);
      const file = `attempt-${index}.log`;
      await fs.writeFile(path.join(outputDir, file), `observed attempt ${index}`);
      const summary = artifactEvidence({ kind: "log", path: file }, "same-label");
      summary.entries[0]!.result = { status };
      owner.complete(occurrenceId, { status, entries: summary.entries });
      prior = occurrenceId;
    }
    owner.select(0, prior!);
    const evidence = owner.snapshot({ generatedAt: "2026-06-17T12:00:00.000Z" });
    await writeJson(evidencePath, evidence);
    const original = await fs.readFile(evidencePath, "utf8");
    const model = await buildQaEvidenceGalleryModel({ evidencePath, repoRoot });
    expect(model.counts).toEqual({ pass: 1, fail: 0, blocked: 0, skipped: 0 });
    expect(model.entries.map(({ key, id, effective }) => ({ key, id, effective }))).toEqual([
      { key: "0", id: "same-label", effective: false },
      { key: "1", id: "same-label", effective: true },
    ]);
    for (const [index, entry] of model.entries.entries()) {
      expect(entry.artifacts[0]?.href).toContain(`entryIndex=${index}&artifactIndex=0`);
      const artifact = await byIndex(index, 0);
      expect(await fs.readFile(artifact, "utf8")).toBe(`observed attempt ${index}`);
    }
    expect(await fs.readFile(evidencePath, "utf8")).toBe(original);
  });
});
