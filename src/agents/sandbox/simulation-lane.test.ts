import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendSimulationLaneDecision,
  appendSimulationLaneOutcome,
  createSimulationLaneManifest,
  createSimulationLaneMetadataEntry,
  materializeSimulationLane,
  validateSimulationLaneRequest,
  verifySimulationLaneLog,
  type SimulationLaneLogEntry,
  type SimulationLaneRequest,
} from "./simulation-lane.js";

const tempDirs: string[] = [];

function createRequest(): SimulationLaneRequest {
  return {
    laneId: "btc-1h-backtest",
    objective: "Evaluate BTC-USDT hourly momentum rule on historical candles.",
    mode: "backtest",
    venue: "binance",
    instrument: "BTC-USDT",
    timeframe: "1h",
    templateId: "ts-research-v1",
    window: {
      start: "2025-01-01T00:00:00.000Z",
      end: "2025-02-01T00:00:00.000Z",
    },
    costAssumptions: {
      feesBps: 5,
      slippageBps: 12,
      spreadBps: 2,
      fundingBpsPerDay: 1.5,
      latencyMs: 250,
      partialFillRate: 0.8,
    },
    notes: "Paper-only research lane",
  };
}

async function createTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-simulation-lane-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("simulation lane", () => {
  it("rejects invalid time windows and cost assumptions", () => {
    const issues = validateSimulationLaneRequest({
      ...createRequest(),
      templateId: "not-a-template" as SimulationLaneRequest["templateId"],
      window: {
        start: "2025-02-01T00:00:00.000Z",
        end: "2025-01-01T00:00:00.000Z",
      },
      costAssumptions: {
        feesBps: -1,
        slippageBps: 12,
        partialFillRate: 1.3,
      },
    });

    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "templateId",
        "window.end",
        "costAssumptions.feesBps",
        "costAssumptions.partialFillRate",
      ]),
    );
  });

  it("materializes a non-live simulation bundle with a metadata log", async () => {
    const destinationDir = await createTempDir();

    const result = await materializeSimulationLane({
      destinationDir,
      request: createRequest(),
      createdAt: "2026-03-11T10:15:00.000Z",
    });

    expect(result.manifest.liveExecutionAllowed).toBe(false);
    expect(result.manifest.templateFingerprint).toBeTruthy();

    const manifestRaw = await fs.readFile(result.manifestPath, "utf8");
    expect(manifestRaw).toContain('"liveExecutionAllowed": false');

    const workspaceMain = await fs.readFile(path.join(result.workspaceDir, "src/main.ts"), "utf8");
    expect(workspaceMain).toContain("summarizeDecision");

    const logRaw = await fs.readFile(result.decisionLogPath, "utf8");
    const entries = logRaw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SimulationLaneLogEntry);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("metadata");
    expect(verifySimulationLaneLog(entries)).toEqual({ ok: true });
  });

  it("chains decision and outcome log entries immutably", () => {
    const manifest = createSimulationLaneManifest({
      request: createRequest(),
      createdAt: "2026-03-11T10:15:00.000Z",
    });
    const metadata = createSimulationLaneMetadataEntry(manifest);
    const decision = appendSimulationLaneDecision([metadata], {
      stepId: "step-1",
      decidedAt: "2026-03-11T10:16:00.000Z",
      action: "enter-long",
      rationale: "Momentum regime stayed above the trigger.",
      confidence: 0.73,
      inputs: { close: 84250.25 },
    });
    const outcome = appendSimulationLaneOutcome([metadata, decision], {
      stepId: "step-1",
      recordedAt: "2026-03-11T10:17:00.000Z",
      status: "accepted",
      summary: "Backtest executed the paper fill.",
      metrics: { pnlUsd: 42.5, maxDrawdownPct: 1.2 },
    });

    const log = [metadata, decision, outcome];
    expect(decision.prevHash).toBe(metadata.hash);
    expect(outcome.prevHash).toBe(decision.hash);
    expect(verifySimulationLaneLog(log)).toEqual({ ok: true });
  });

  it("detects tampered log payloads", () => {
    const manifest = createSimulationLaneManifest({
      request: createRequest(),
      createdAt: "2026-03-11T10:15:00.000Z",
    });
    const metadata = createSimulationLaneMetadataEntry(manifest);
    const decision = appendSimulationLaneDecision([metadata], {
      stepId: "step-1",
      decidedAt: "2026-03-11T10:16:00.000Z",
      action: "enter-long",
      rationale: "Original rationale.",
    });

    const tampered = {
      ...decision,
      payload: {
        ...decision.payload,
        rationale: "Tampered rationale.",
      },
    };

    expect(verifySimulationLaneLog([metadata, tampered])).toEqual(
      expect.objectContaining({
        ok: false,
        index: 1,
      }),
    );
  });
});
