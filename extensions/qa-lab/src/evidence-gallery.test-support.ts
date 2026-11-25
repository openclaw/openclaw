import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { QaEvidenceSummaryJson } from "./evidence-summary.js";

export async function createTempRepo(prefix = "qa-evidence-gallery-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function vitestArtifactEvidence(params: {
  id: string;
  title: string;
  artifact: { kind: string; path: string };
}): Extract<QaEvidenceSummaryJson, { schemaVersion: 2 }> {
  return {
    kind: "openclaw.qa.evidence-summary",
    schemaVersion: 2,
    generatedAt: "2026-06-17T12:00:00.000Z",
    evidenceMode: "full",
    entries: [
      {
        test: { kind: "vitest-test", id: params.id, title: params.title },
        coverage: [{ id: "qa.artifact", role: "primary" }],
        execution: {
          runner: "vitest",
          environment: { ref: "gallery-test", os: "darwin", nodeVersion: "v24.0.0" },
          provider: {
            id: "mock-openai",
            live: false,
            model: { name: "mock-openai/gpt-5.6-luna", ref: "mock-openai/gpt-5.6-luna" },
          },
          packageSource: { kind: "source-checkout" },
          artifacts: [{ ...params.artifact, source: "vitest" }],
        },
        result: { status: "pass" },
      },
    ],
  };
}
