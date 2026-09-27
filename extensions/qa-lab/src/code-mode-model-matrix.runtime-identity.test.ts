import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseCodeModeMatrixOptions,
  runCodeModeModelMatrix,
  validateQaEvidenceSummaryJson,
} from "../../../scripts/code-mode-model-matrix.ts";
import { mockBunVersion } from "./runtime-version.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Code Mode matrix runtime identity", () => {
  it.each([
    { label: "Node", bun: undefined, runtime: { id: "node", version: process.version } },
    { label: "simulated Bun", bun: "1.3.14", runtime: { id: "bun", version: "1.3.14" } },
  ])("records $label with the selected source after a cell failure", async ({ bun, runtime }) => {
    using _ = mockBunVersion(bun);
    const repoRoot = tempDirs.make("openclaw-matrix-runtime-identity-");
    const sourceIdentity = {
      gitSha: "fixture-selected-source",
      sourceDirty: true,
      sourcePatchSha256: "a".repeat(64),
    };
    const readSourceIdentity = vi.fn(async () => sourceIdentity);
    const result = await runCodeModeModelMatrix(
      parseCodeModeMatrixOptions(
        [
          "--model",
          "fixture/model",
          "--mode",
          "code",
          "--repetitions",
          "1",
          "--task",
          "read",
          "--output-dir",
          "artifacts",
        ],
        repoRoot,
      ),
      {
        readSourceIdentity,
        buildCliArtifacts: async () => {},
        readBuildSha256: async () => "fixture-build",
        runCell: async () => {
          throw new Error("fixture cell failure");
        },
      },
    );
    expect(readSourceIdentity).toHaveBeenCalledTimes(1);
    expect(readSourceIdentity).toHaveBeenCalledWith(repoRoot);
    expect(result.exitCode).toBe(1);
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(path.join(result.outputDir, "qa-evidence.json"), "utf8")),
    );
    if (evidence.schemaVersion !== 3) {
      throw new Error("expected captured launch identity");
    }
    expect(evidence.occurrences).toHaveLength(2);
    const launch = {
      source: {
        ref: sourceIdentity.gitSha,
        integrity: `git:${sourceIdentity.gitSha}+sha256:${sourceIdentity.sourcePatchSha256}`,
      },
      runtime,
      package: null,
      protocol: null,
      accountRef: null,
      proofClass: null,
    };
    for (const occurrence of evidence.occurrences) {
      expect(occurrence.launch).toEqual(launch);
    }
    const observation = evidence.occurrences.find((item) => item.scenario?.kind === "observation")!;
    expect(observation.terminalStatus).toBe("fail");
    expect(observation.receipts).toHaveLength(1);
    const receipt = observation.receipts[0]!;
    expect(receipt.phase).toBe("prepared");
    expect(receipt.identity).toEqual(launch);
    const bytes = await fs.readFile(path.join(result.outputDir, receipt.artifact.path));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(receipt.artifact.sha256);
    expect(JSON.parse(bytes.toString())).toMatchObject({
      launch,
      buildSha256: "fixture-build",
      result: { evidenceOccurrenceId: observation.id },
    });
  });
});
