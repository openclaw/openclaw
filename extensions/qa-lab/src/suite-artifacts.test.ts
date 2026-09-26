// Qa Lab tests cover immutable suite evidence and presentation artifacts.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildQaEvidenceGalleryModel,
  resolveQaEvidenceArtifactFile,
  resolveQaEvidenceArtifactFileByIndex,
} from "./evidence-gallery.js";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import {
  QA_EVIDENCE_FILENAME,
  QA_EVIDENCE_SUMMARY_KIND,
  validateQaEvidenceSummaryJson,
} from "./evidence-summary.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import { writeQaSuiteArtifacts } from "./suite-artifacts.js";
import { createQaSuiteEvidenceInvocation, rebaseQaSuiteEvidence } from "./suite-evidence.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const tempDirs = createTempDirHarness();

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

afterEach(async () => {
  fetchWithSsrFGuardMock.mockReset();
  vi.useRealTimers();
  await tempDirs.cleanup();
});

describe("suite artifacts", () => {
  it("writes standalone evidence while keeping suite summary evidence-free", async () => {
    const outputDir = await tempDirs.makeTempDir("qa-suite-artifacts-");
    try {
      const artifacts = await writeQaSuiteArtifacts({
        outputDir,
        startedAt: new Date("2026-04-11T00:00:00.000Z"),
        finishedAt: new Date("2026-04-11T00:01:00.000Z"),
        scenarios: [{ name: "Baseline", status: "pass", steps: [] }],
        scenarioDefinitions: [
          {
            ...makeQaSuiteTestScenario("baseline", {
              surface: "channel",
            }),
            coverage: {
              primary: ["channels.messages"],
            },
          },
        ],
        transport: {
          id: "qa-channel",
          createReportNotes: () => [],
        } as unknown as QaTransportAdapter,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        fastMode: true,
        concurrency: 1,
      });

      expect(artifacts.evidencePath).toBe(path.join(outputDir, QA_EVIDENCE_FILENAME));
      const evidence = JSON.parse(await fs.readFile(artifacts.evidencePath, "utf8")) as {
        kind?: string;
        entries?: unknown[];
      };
      expect(evidence.kind).toBe(QA_EVIDENCE_SUMMARY_KIND);
      expect(evidence.entries).toHaveLength(1);
      const summary = JSON.parse(await fs.readFile(artifacts.summaryPath, "utf8")) as {
        evidence?: unknown;
      };
      expect(summary.evidence).toBeUndefined();
      if (process.platform !== "win32") {
        for (const artifactPath of [
          artifacts.reportPath,
          artifacts.evidencePath,
          artifacts.summaryPath,
        ]) {
          expect((await fs.stat(artifactPath)).mode & 0o777).toBe(0o600);
        }
      }
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("can return evidence without writing duplicate child evidence files", async () => {
    const outputDir = await tempDirs.makeTempDir("qa-suite-artifacts-memory-evidence-");
    try {
      await fs.writeFile(path.join(outputDir, QA_EVIDENCE_FILENAME), "stale evidence\n", "utf8");
      const artifacts = await writeQaSuiteArtifacts({
        outputDir,
        startedAt: new Date("2026-04-11T00:00:00.000Z"),
        finishedAt: new Date("2026-04-11T00:01:00.000Z"),
        scenarios: [{ name: "Baseline", status: "pass", steps: [] }],
        scenarioDefinitions: [makeQaSuiteTestScenario("baseline")],
        transport: {
          id: "qa-channel",
          createReportNotes: () => [],
        } as unknown as QaTransportAdapter,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        fastMode: true,
        concurrency: 1,
        writeEvidenceFile: false,
      });

      expect(artifacts.evidence?.kind).toBe(QA_EVIDENCE_SUMMARY_KIND);
      await expect(fs.access(artifacts.evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
      await fs.access(artifacts.reportPath);
      await fs.access(artifacts.summaryPath);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("distinguishes partial Markdown from the terminal report shape", async () => {
    const outputDir = await tempDirs.makeTempDir("qa-suite-report-lifecycle-");
    const baseParams = {
      outputDir,
      startedAt: new Date("2026-04-11T00:00:00.000Z"),
      finishedAt: new Date("2026-04-11T00:01:00.000Z"),
      scenarios: [{ name: "Baseline", status: "pass" as const, steps: [] }],
      scenarioDefinitions: [makeQaSuiteTestScenario("baseline")],
      transport: {
        id: "qa-channel",
        createReportNotes: () => [],
      } as unknown as QaTransportAdapter,
      providerMode: "mock-openai" as const,
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      fastMode: true,
      concurrency: 1,
    };

    try {
      const partial = await writeQaSuiteArtifacts({ ...baseParams, status: "running" });
      expect(partial.report).toContain("# OpenClaw QA Scenario Suite (In Progress)");
      expect(partial.report).toContain("- Status: running");
      expect(partial.report).toContain("- Updated: 2026-04-11T00:01:00.000Z");
      expect(partial.report).not.toContain("- Finished:");
      await expect(fs.access(partial.evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(partial.summaryPath, "utf8")).resolves.toContain(
        '"status": "running"',
      );

      const terminal = await writeQaSuiteArtifacts(baseParams);
      expect(terminal.report).toContain("# OpenClaw QA Scenario Suite\n");
      expect(terminal.report).toContain("- Finished: 2026-04-11T00:01:00.000Z");
      expect(terminal.report).not.toContain("In Progress");
      expect(terminal.report).not.toContain("- Status: running");
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "writes the selected Crabline driver with an honest failed result (recorded=%s)",
    async (recorded) => {
      const repoRoot = await tempDirs.makeTempDir("qa-suite-crabline-");
      const outputDir = path.join(repoRoot, "nested");
      await fs.mkdir(outputDir);
      try {
        fetchWithSsrFGuardMock.mockResolvedValue({
          response: {
            ok: true,
            json: vi.fn(async () => ({
              ok: true,
              result: {
                is_bot: true,
                username: "crabline_bot",
              },
            })),
          },
          release: vi.fn(async () => {}),
        });

        const scenario = {
          ...makeQaSuiteTestScenario("telegram-dm", { surface: "channel" }),
          coverage: { primary: ["channels.dm"] },
        };
        const result = {
          name: "Telegram DM",
          status: "fail" as const,
          details: "active transport does not implement this scenario",
          steps: [],
        };
        const invocation = createQaEvidenceInvocation({
          scenarios: [scenario],
          channel: "telegram",
          launch: {
            source: { ref: null, integrity: null },
            runtime: { id: null, version: null },
            package: null,
            protocol: null,
            accountRef: null,
            proofClass: null,
          },
        });
        const recorder = await createQaSuiteEvidenceInvocation(
          {
            evidenceAnchors: invocation.anchors,
            channelId: "telegram",
            channelDriver: "crabline",
            onEvidence: (snapshot) => invocation.importChild(0, snapshot),
          },
          {
            repoRoot,
            outputDir,
            primaryModel: "mock-openai/gpt-5.6-luna",
            providerMode: "mock-openai",
            selectedScenarios: [scenario],
            transportId: "qa-channel",
          },
        );
        const id = recorder.invocation.begin(0);
        await recorder.record(0, id, result);
        invocation.select(0, id);
        const recordedEvidence = recorder.snapshot();
        const before = structuredClone(recordedEvidence);
        const artifactGenerationDirectory = path.join(
          ".crabline-channel-driver-artifacts",
          "generation-test",
        );
        const capabilityMatrixPath = path.join(
          artifactGenerationDirectory,
          "crabline-channel-driver-capabilities.json",
        );
        const providerReadinessArtifactPath = path.join(
          artifactGenerationDirectory,
          "crabline-provider-readiness.json",
        );
        await fs.mkdir(path.resolve(outputDir, artifactGenerationDirectory), { recursive: true });
        await fs.writeFile(
          path.resolve(outputDir, capabilityMatrixPath),
          JSON.stringify({ report: { result: { selectedChannel: "telegram" } } }),
        );
        await fs.writeFile(
          path.resolve(outputDir, providerReadinessArtifactPath),
          JSON.stringify({ providerReadiness: { result: { ok: true, provider: "telegram" } } }),
        );
        const artifacts = await writeQaSuiteArtifacts({
          outputDir,
          startedAt: new Date("2026-04-11T00:00:00.000Z"),
          finishedAt: new Date("2026-04-11T00:01:00.000Z"),
          scenarios: [result],
          scenarioDefinitions: [scenario],
          ...(recorded ? { recordedEvidence } : {}),
          transport: {
            id: "qa-channel",
            createReportNotes: () => [],
          } as unknown as QaTransportAdapter,
          providerMode: "mock-openai",
          primaryModel: "mock-openai/gpt-5.6-luna",
          alternateModel: "mock-openai/gpt-5.6-luna-alt",
          fastMode: true,
          concurrency: 1,
          channel: "telegram",
          channelDriver: "crabline",
          transportArtifacts: {
            artifacts: [
              { kind: "channel-capability-matrix", path: capabilityMatrixPath },
              { kind: "channel-driver-smoke", path: providerReadinessArtifactPath },
            ],
            reportNotes: ["Transport-owned artifact evidence captured."],
          },
        });

        const summary = JSON.parse(await fs.readFile(artifacts.summaryPath, "utf8")) as {
          run?: {
            channelCapabilityMatrixPath?: string;
            channelDriverSmokePath?: string;
          };
        };
        expect(summary.run?.channelCapabilityMatrixPath).toBe(capabilityMatrixPath);
        expect(summary.run?.channelDriverSmokePath).toBe(providerReadinessArtifactPath);
        await expect(
          fs.access(path.join(outputDir, "crabline-channel-driver-capabilities.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          fs.access(path.join(outputDir, "crabline-provider-readiness.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        const matrix = JSON.parse(
          await fs.readFile(path.resolve(outputDir, capabilityMatrixPath), "utf8"),
        ) as {
          report?: { result?: { selectedChannel?: string; supportedChannels?: string[] } };
        };
        expect(matrix.report?.result?.selectedChannel).toBe("telegram");
        const readiness = JSON.parse(
          await fs.readFile(path.resolve(outputDir, providerReadinessArtifactPath), "utf8"),
        ) as { providerReadiness?: { result?: { ok?: boolean; provider?: string } } };
        expect(readiness.providerReadiness?.result).toMatchObject({
          ok: true,
          provider: "telegram",
        });
        const evidence = JSON.parse(await fs.readFile(artifacts.evidencePath, "utf8")) as {
          entries?: Array<{
            execution?: {
              artifacts?: Array<{ kind?: string; path?: string }>;
              channel?: { driver?: string; id?: string };
            };
            result?: { failure?: { reason?: string }; status?: string };
          }>;
        };
        if (!recorded) {
          expect(evidence.entries?.[0]?.execution?.artifacts).toEqual(
            expect.arrayContaining([
              { kind: "summary", path: "qa-suite-summary.json", source: "qa-suite" },
              { kind: "report", path: "qa-suite-report.md", source: "qa-suite" },
              { kind: "channel-capability-matrix", path: capabilityMatrixPath, source: "qa-suite" },
              {
                kind: "channel-driver-smoke",
                path: providerReadinessArtifactPath,
                source: "qa-suite",
              },
            ]),
          );
        }
        if (recorded) {
          const parsed = validateQaEvidenceSummaryJson(evidence);
          expect(parsed.schemaVersion).toBe(3);
          if (parsed.schemaVersion !== 3) {
            throw new Error("expected recorded occurrences");
          }
          expect(parsed.occurrences).toEqual(before.occurrences);
          expect(parsed).toEqual(before);
          expect(() => invocation.importChild(0, parsed)).not.toThrow();
          expect(parsed.entries[0]?.binding).toEqual(before.entries[0]?.binding);
          expect(recordedEvidence).toEqual(before);
          expect(parsed.occurrences.flatMap((occurrence) => occurrence.receipts)).toHaveLength(1);
          const rebased = rebaseQaSuiteEvidence(parsed, outputDir, path.dirname(outputDir));
          expect(rebased.entries[0]?.execution?.artifacts).toEqual(
            parsed.entries[0]?.execution?.artifacts.map((artifact) =>
              Object.assign({}, artifact, {
                path: `${path.basename(outputDir)}/${artifact.path}`,
              }),
            ),
          );
          const parentEvidencePath = path.join(repoRoot, QA_EVIDENCE_FILENAME);
          await fs.writeFile(parentEvidencePath, JSON.stringify(rebased));
          const originalBytes = await fs.readFile(parentEvidencePath);
          for (const evidencePath of [artifacts.evidencePath, parentEvidencePath]) {
            const gallery = await buildQaEvidenceGalleryModel({ evidencePath, repoRoot });
            expect(gallery.counts).toEqual({ pass: 0, fail: 1, blocked: 0, skipped: 0 });
            for (const [kind, relative] of [
              ["channel-capability-matrix", capabilityMatrixPath],
              ["channel-driver-smoke", providerReadinessArtifactPath],
            ]) {
              const artifactIndex = gallery.entries[0]!.artifacts.findIndex(
                (item) => item.kind === kind,
              );
              expect(artifactIndex).toBeGreaterThanOrEqual(0);
              const indexed = await resolveQaEvidenceArtifactFileByIndex({
                evidencePath,
                repoRoot,
                entryIndex: 0,
                artifactIndex,
              });
              const declared = await resolveQaEvidenceArtifactFile({
                evidencePath,
                repoRoot,
                artifactPath: path.join(outputDir, relative!),
              });
              expect(await fs.readFile(indexed)).toEqual(await fs.readFile(declared));
              expect(await fs.readFile(indexed)).toEqual(
                await fs.readFile(path.join(outputDir, relative!)),
              );
            }
          }
          expect(await fs.readFile(parentEvidencePath)).toEqual(originalBytes);
        }
        expect(evidence.entries?.[0]?.execution?.channel).toMatchObject({
          driver: "crabline",
          id: "telegram",
        });
        expect(evidence.entries?.[0]?.result).toMatchObject({
          failure: { reason: "active transport does not implement this scenario" },
          status: "fail",
        });
      } finally {
        await fs.rm(outputDir, { recursive: true, force: true });
      }
    },
  );
});
