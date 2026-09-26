// Qa Lab tests cover presentation projection and occurrence-specific downloads.
import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildQaEvidenceGalleryModel,
  resolveQaEvidenceArtifactFile,
  resolveQaEvidenceArtifactFileByIndex,
} from "./evidence-gallery.js";
import { vitestArtifactEvidence, writeJson } from "./evidence-gallery.test-support.js";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import { QA_EVIDENCE_FILENAME } from "./evidence-summary.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("evidence gallery presentation", () => {
  it("bounds presentation reads and shares in-flight child summaries without reordering rows", async () => {
    const repoRoot = tempDirs.make("qa-evidence-gallery-");
    const readFile = fs.readFile.bind(fs);
    const reads = new Map<string, number>();
    let active = 0;
    let peak = 0;
    const outputDir = path.join(repoRoot, "evidence");
    const source = vitestArtifactEvidence({
      id: "repeated",
      title: "Repeated summary",
      artifact: { kind: "summary", path: "unused" },
    });
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
    const evidencePath = path.join(outputDir, QA_EVIDENCE_FILENAME);
    await writeJson(evidencePath, source);
    const spy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
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
    try {
      const gallery = await buildQaEvidenceGalleryModel({ evidencePath, repoRoot });
      expect([...reads.values()]).toEqual(Array(12).fill(1));
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(8);
      expect(active).toBe(0);
      expect(gallery.entries.map((entry) => entry.id)).toEqual(
        source.entries.map((entry) => entry.test.id),
      );
      expect(gallery.counts.pass).toBe(24);
    } finally {
      spy.mockRestore();
    }
  });

  it.each(["full", "slim"] as const)(
    "projects contained suite presentation without rewriting %s rows or counts",
    async (evidenceMode) => {
      const repoRoot = tempDirs.make("qa-evidence-gallery-");
      const outsideRoot = tempDirs.make("qa-gallery-outside-");
      const outputDir = path.join(repoRoot, "evidence");
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
      const source = vitestArtifactEvidence({
        id: "recorded",
        title: "Recorded row",
        artifact: { kind: "summary", path: "child/qa-suite-summary.json" },
      });
      source.entries[0]!.execution!.artifacts[0]!.source = "qa-suite";
      const owner = createQaEvidenceInvocation({
        scenarios: [{ id: "recorded", execution: { kind: "script" } }],
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
      const id = owner.begin(0);
      owner.complete(id, { status: "pass", entries: source.entries });
      owner.select(0, id);
      const evidence = owner.snapshot({ generatedAt: source.generatedAt, evidenceMode });
      const evidencePath = path.join(outputDir, QA_EVIDENCE_FILENAME);
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
        const indexed = await resolveQaEvidenceArtifactFileByIndex({
          evidencePath,
          repoRoot,
          entryIndex: 0,
          artifactIndex: 1,
        });
        const declared = await resolveQaEvidenceArtifactFile({
          evidencePath,
          repoRoot,
          artifactPath: matrixPath,
        });
        expect(await fs.readFile(indexed)).toEqual(await fs.readFile(declared));
      } else {
        expect(gallery.entries[0]!.artifacts).toEqual([]);
        expect(evidence.entries[0]!.execution).toBeUndefined();
      }
      await expect(
        resolveQaEvidenceArtifactFile({ evidencePath, repoRoot, artifactPath: escaped }),
      ).rejects.toThrow("not found");
      expect(await fs.readFile(evidencePath)).toEqual(bytes);
    },
  );

  it("keeps duplicate labels and raw artifact indices while counting only the selected retry", async () => {
    const repoRoot = tempDirs.make("qa-evidence-gallery-");
    const outputDir = path.join(repoRoot, "evidence");
    await fs.mkdir(outputDir);
    const invocation = createQaEvidenceInvocation({
      scenarios: [{ id: "same-label", execution: { kind: "script" } }],
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
    let prior: string | null = null;
    for (const [index, status] of (["fail", "pass"] as const).entries()) {
      const occurrenceId = invocation.begin(0, prior);
      const file = `attempt-${index}.log`;
      await fs.writeFile(path.join(outputDir, file), `observed attempt ${index}`);
      const summary = vitestArtifactEvidence({
        id: "same-label",
        title: `Attempt ${index}`,
        artifact: { kind: "log", path: file },
      });
      summary.entries[0]!.result = { status };
      invocation.complete(occurrenceId, { status, entries: summary.entries });
      prior = occurrenceId;
    }
    invocation.select(0, prior!);
    const evidence = invocation.snapshot({ generatedAt: "2026-06-17T12:00:00.000Z" });
    const evidencePath = path.join(outputDir, QA_EVIDENCE_FILENAME);
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
      const artifact = await resolveQaEvidenceArtifactFileByIndex({
        artifactIndex: 0,
        entryIndex: index,
        evidencePath,
        repoRoot,
      });
      expect(await fs.readFile(artifact, "utf8")).toBe(`observed attempt ${index}`);
    }
    expect(await fs.readFile(evidencePath, "utf8")).toBe(original);
  });
});
