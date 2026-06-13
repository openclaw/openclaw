// Qa Lab tests cover WhatsApp live transport cli runtime behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QA_EVIDENCE_FILENAME } from "../../evidence-summary.js";
import { runQaWhatsAppCommand } from "./cli.runtime.js";

const runWhatsAppQaLiveMock = vi.hoisted(() => vi.fn());

vi.mock("../shared/live-artifacts.js", () => ({
  printLiveTransportQaArtifacts: vi.fn(),
}));

vi.mock("../shared/live-transport-cli.runtime.js", () => ({
  resolveLiveTransportQaRunOptions: (opts: Record<string, unknown>) => ({
    outputDir: opts.repoRoot,
    providerMode: "mock-openai",
    repoRoot: opts.repoRoot,
    ...opts,
  }),
}));

vi.mock("./whatsapp-live.runtime.js", () => ({
  runWhatsAppQaLive: runWhatsAppQaLiveMock,
}));

const tempDirs: string[] = [];
let originalExitCode: typeof process.exitCode;

afterEach(async () => {
  process.exitCode = originalExitCode;
  runWhatsAppQaLiveMock.mockReset();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function writeSummary(summary: unknown) {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-whatsapp-cli-"));
  tempDirs.push(outputDir);
  const summaryPath = path.join(outputDir, QA_EVIDENCE_FILENAME);
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return { outputDir, summaryPath };
}

function makeEvidenceSummary(status: "pass" | "fail" | "blocked" | "skipped") {
  return {
    kind: "openclaw.qa.evidence-summary",
    schemaVersion: 2,
    generatedAt: "2026-05-01T00:00:00.000Z",
    entries: [
      {
        test: {
          kind: "live-transport-check",
          id: "whatsapp-mention-gating",
          title: "WhatsApp mention gating",
        },
        mapping: { profile: "release", coverage: [] },
        execution: {
          runner: "host",
          environment: { ref: null, os: "darwin", nodeVersion: "v24.0.0" },
          provider: {
            id: "openai",
            live: false,
            model: { name: null, ref: null },
            fixture: "mock-openai",
          },
          channel: { id: "whatsapp", live: true, driver: "native" },
          packageSource: { kind: "source-checkout" },
          artifacts: [],
        },
        result: { status },
      },
    ],
  };
}

describe("WhatsApp QA CLI runtime", () => {
  it("fails when a requirement is skipped by default", async () => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const { outputDir, summaryPath } = await writeSummary(makeEvidenceSummary("skipped"));
    runWhatsAppQaLiveMock.mockResolvedValueOnce({
      observedMessagesPath: path.join(outputDir, "observed.json"),
      reportPath: path.join(outputDir, "report.md"),
      scenarios: [],
      summaryPath,
    });

    await runQaWhatsAppCommand({ repoRoot: outputDir });

    expect(process.exitCode).toBe(1);
  });

  it("allows skipped scenarios when failures are explicitly allowed", async () => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const { outputDir, summaryPath } = await writeSummary(makeEvidenceSummary("skipped"));
    runWhatsAppQaLiveMock.mockResolvedValueOnce({
      observedMessagesPath: path.join(outputDir, "observed.json"),
      reportPath: path.join(outputDir, "report.md"),
      scenarios: [],
      summaryPath,
    });

    await runQaWhatsAppCommand({ allowFailures: true, repoRoot: outputDir });

    expect(process.exitCode).toBeUndefined();
  });
});
