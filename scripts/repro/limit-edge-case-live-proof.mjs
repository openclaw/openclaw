#!/usr/bin/env node
/**
 * Live repro for limit/CLI numeric fixes (PR #82679). Run: pnpm exec tsx scripts/repro/limit-edge-case-live-proof.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __testing as voiceCallCliTesting } from "../../extensions/voice-call/src/cli.ts";
import { loadSessionLogs, loadSessionUsageTimeSeries } from "../../src/infra/session-cost-usage.ts";
import {
  getRecentDiagnosticPhases,
  recordDiagnosticPhase,
  resetDiagnosticPhasesForTest,
} from "../../src/logging/diagnostic-phase.ts";

async function main() {
  resetDiagnosticPhasesForTest();
  recordDiagnosticPhase({
    name: "phase-a",
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    cpuUserMs: 0,
    cpuSystemMs: 0,
    cpuTotalMs: 0,
    cpuCoreRatio: 0,
  });
  console.log("getRecentDiagnosticPhases(0).length =", getRecentDiagnosticPhases(0).length);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proof-"));
  const sessionFile = path.join(root, "s.jsonl");
  fs.writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "a" },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T00:01:00.000Z",
        message: { role: "user", content: "b" },
      }),
    ].join("\n"),
  );

  const logs = await loadSessionLogs({ sessionFile, limit: 0 });
  const series = await loadSessionUsageTimeSeries({ sessionFile, maxPoints: 0 });
  console.log("loadSessionLogs({ limit: 0 }).length =", logs?.length);
  console.log(
    "loadSessionUsageTimeSeries({ maxPoints: 0 }).points.length =",
    series?.points.length,
  );

  try {
    voiceCallCliTesting.parseVoiceCallIntOption("nope", "--port", { min: 1 });
  } catch (error) {
    console.log(
      "parseVoiceCallIntOption('nope', '--port') error:",
      error instanceof Error ? error.message : error,
    );
  }
}

await main();
