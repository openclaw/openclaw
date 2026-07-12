// Qa Lab tests cover WhatsApp live transport cli runtime behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QA_EVIDENCE_FILENAME } from "../../evidence-summary.js";
import { runQaWhatsAppCommand } from "./cli.runtime.js";

const { listWhatsAppQaScenarioCatalogMock, runCanonicalLiveScenariosMock, runWhatsAppQaLiveMock } =
  vi.hoisted(() => ({
    listWhatsAppQaScenarioCatalogMock: vi.fn(),
    runCanonicalLiveScenariosMock: vi.fn(),
    runWhatsAppQaLiveMock: vi.fn(),
  }));

vi.mock("../shared/live-artifacts.js", () => ({
  printLiveTransportQaArtifacts: vi.fn(),
}));

vi.mock("../shared/canonical-scenarios.js", async (importOriginal) => ({
  ...(await importOriginal()),
  runCanonicalLiveScenarios: runCanonicalLiveScenariosMock,
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
  listWhatsAppQaScenarioCatalog: listWhatsAppQaScenarioCatalogMock,
  runWhatsAppQaLive: runWhatsAppQaLiveMock,
}));

vi.mock("./adapter.runtime.js", () => ({
  createWhatsAppQaTransportAdapter: vi.fn(),
}));

const tempDirs: string[] = [];
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  listWhatsAppQaScenarioCatalogMock.mockReturnValue([{ id: "whatsapp-canary" }]);
});

afterEach(async () => {
  process.exitCode = originalExitCode;
  runCanonicalLiveScenariosMock.mockReset();
  runWhatsAppQaLiveMock.mockReset();
  listWhatsAppQaScenarioCatalogMock.mockReset();
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
    evidenceMode: "full",
    entries: [
      {
        test: {
          kind: "live-transport-check",
          id: "whatsapp-mention-gating",
          title: "WhatsApp mention gating",
        },
        coverage: [],
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
    runCanonicalLiveScenariosMock.mockResolvedValueOnce({
      outputDir,
      reportPath: path.join(outputDir, "canonical-report.md"),
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
    runCanonicalLiveScenariosMock.mockResolvedValueOnce({
      outputDir,
      reportPath: path.join(outputDir, "canonical-report.md"),
      scenarios: [],
      summaryPath,
    });

    await runQaWhatsAppCommand({ allowFailures: true, repoRoot: outputDir });

    expect(process.exitCode).toBeUndefined();
  });

  it("delegates canonical WhatsApp scenario ids without starting the legacy runner", async () => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const { outputDir, summaryPath } = await writeSummary(makeEvidenceSummary("pass"));
    runCanonicalLiveScenariosMock.mockResolvedValueOnce({
      outputDir,
      reportPath: path.join(outputDir, "canonical-report.md"),
      scenarios: [],
      summaryPath,
    });

    await runQaWhatsAppCommand({
      repoRoot: outputDir,
      scenarioIds: ["whatsapp-help-command"],
    });

    expect(runCanonicalLiveScenariosMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "whatsapp",
        scenarioIds: ["whatsapp-help-command"],
      }),
    );
    expect(runWhatsAppQaLiveMock).not.toHaveBeenCalled();
  });

  it("keeps remaining WhatsApp defaults when Commander supplies an empty scenario list", async () => {
    const { outputDir, summaryPath } = await writeSummary(makeEvidenceSummary("pass"));
    runWhatsAppQaLiveMock.mockResolvedValueOnce({
      observedMessagesPath: path.join(outputDir, "observed.json"),
      reportPath: path.join(outputDir, "report.md"),
      scenarios: [],
      summaryPath,
    });
    runCanonicalLiveScenariosMock.mockResolvedValueOnce({
      outputDir,
      reportPath: path.join(outputDir, "canonical-report.md"),
      scenarios: [],
      summaryPath,
    });

    await runQaWhatsAppCommand({ repoRoot: outputDir, scenarioIds: [] });

    expect(runCanonicalLiveScenariosMock).toHaveBeenCalled();
    expect(runWhatsAppQaLiveMock).toHaveBeenCalledWith(
      expect.objectContaining({ scenarioIds: undefined }),
    );
  });

  it("rejects unknown mixed WhatsApp selections before starting canonical scenarios", async () => {
    await expect(
      runQaWhatsAppCommand({
        repoRoot: "/tmp/openclaw-repo",
        scenarioIds: ["whatsapp-help-command", "missing-whatsapp-scenario"],
      }),
    ).rejects.toThrow("unknown WhatsApp QA scenario id(s): missing-whatsapp-scenario");

    expect(runCanonicalLiveScenariosMock).not.toHaveBeenCalled();
    expect(runWhatsAppQaLiveMock).not.toHaveBeenCalled();
  });
});
