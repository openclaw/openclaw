import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");

const DEFAULT_WEEKLY_SIM_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-holiday-weekly-simulation-latest.json",
);
const DEFAULT_DMAD_RUN_PATH = path.join(repoRoot, "reports", "dmad-run-test-latest.json");
const DEFAULT_HERMES_OUT = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-holiday-weekly-feedback-latest.json",
);
const DEFAULT_OPENCLAW_OUT = path.join(
  repoRoot,
  ".openclaw",
  "trading",
  "capital-holiday-weekly-feedback.json",
);

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeJsonWithSha(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256(payload)}\n`, "ascii");
}

export async function runCapitalHolidayWeeklyFeedbackBridge(options = {}) {
  const weeklyPath = path.resolve(options.weeklyPath || DEFAULT_WEEKLY_SIM_PATH);
  const dmadPath = path.resolve(options.dmadPath || DEFAULT_DMAD_RUN_PATH);
  const hermesOutPath = path.resolve(options.hermesOutPath || DEFAULT_HERMES_OUT);
  const openclawOutPath = path.resolve(options.openclawOutPath || DEFAULT_OPENCLAW_OUT);

  const weekly = await readJson(weeklyPath);
  const dmad = await readJson(dmadPath);
  const dmadTimeout = dmad.runStatus === "timeout" || dmad.stoppedBy === "timeout";
  const dmadCompleted =
    Array.isArray(dmad.rounds) &&
    Number(dmad.totalRounds ?? 0) > 0 &&
    typeof dmad.completedAt === "string" &&
    dmad.completedAt.length > 0;
  const finalAnswer = String(dmad.finalAnswer ?? "");
  const dmadQuality = String(dmad.qualityStatus ?? "");
  const dmadQualityPass = dmadQuality === "pass" && !String(dmad.degradedReason ?? "");
  const moaFailed = !dmadQualityPass && /呼叫失敗|timed out|timeout/i.test(finalAnswer);
  const dmadCompletedWithoutTimeout = (dmad.ok === true || dmadCompleted) && !dmadTimeout;
  const dmadDegraded = dmadQuality === "degraded_agents" || !!String(dmad.degradedReason ?? "");
  const dmadReadyWithDegraded = dmadCompletedWithoutTimeout && (moaFailed || dmadDegraded);
  const dmadOk = dmadCompletedWithoutTimeout && !moaFailed && !dmadDegraded;

  const report = {
    schema: "openclaw.capital.holiday-weekly-feedback-bridge.v1",
    generatedAt: new Date().toISOString(),
    provider: "capital",
    status: dmadOk
      ? "ready_for_parameter_tuning"
      : dmadReadyWithDegraded
        ? "ready_with_degraded_dmad"
        : dmadTimeout
          ? "dmad_timeout_blocked"
          : "dmad_degraded_blocked",
    source: {
      weeklySimulationPath: weeklyPath,
      dmadRunPath: dmadPath,
    },
    weeklySummary: {
      events: Number(weekly?.weeklySample?.events ?? 0),
      tradingDays: Number(weekly?.weeklySample?.tradingDays ?? 0),
      holidayGaps: Number(weekly?.weeklySample?.holidayGaps ?? 0),
      bestStrategy: String(weekly?.ranking?.[0]?.strategy ?? ""),
      bestPnlPts: Number(weekly?.ranking?.[0]?.totalPnlPts ?? 0),
    },
    dmadSummary: {
      ok: dmad.ok === true || dmadCompleted,
      runStatus: String(dmad.runStatus ?? (dmadCompletedWithoutTimeout ? "completed" : "")),
      qualityStatus: String(dmad.qualityStatus ?? ""),
      degradedReason: String(dmad.degradedReason ?? ""),
      totalRounds: Number(dmad.totalRounds ?? 0),
      durationMs: Number(dmad.durationMs ?? dmad.phaseTimingsMs?.total ?? 0),
      totalTimeoutMs: Number(dmad.totalTimeoutMs ?? dmad.runConfig?.totalTimeoutMs ?? 0),
      timeoutPhase: String(dmad.timeoutPhase ?? ""),
      activeAgents: Array.isArray(dmad.activeAgents) ? dmad.activeAgents : [],
    },
    handoff: {
      toHermesAgent: true,
      toOpenClawRuntime: true,
      synced: true,
      note: "Holiday weekly strategy simulation + DMAD run state bridged for controlled next-step routing.",
    },
    safety: {
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      paperOnly: true,
    },
    blockerCode: dmadOk
      ? ""
      : dmadReadyWithDegraded
        ? "DMAD_DEGRADED_BUT_CONTINUABLE"
        : dmadTimeout
          ? "DMAD_RUN_TIMEOUT"
          : moaFailed
            ? "DMAD_MOA_FAILED"
            : "DMAD_DEGRADED",
    nextSafeTask: dmadOk
      ? "依 DMAD 結論微調 paper strategy 參數後，重跑 weekly simulation 與 bridge。"
      : dmadReadyWithDegraded
        ? "保留 paper-only；用 round2 的 Claude/Codex/OpenClaw 輸出做參數微調，並在下一輪提升 MOA 穩定度。"
        : dmadTimeout
          ? "延長 DMAD_RUN_TEST_TOTAL_TIMEOUT_MS 至 180000 後重跑；仍保持 paper-only 與 broker write 關閉。"
          : moaFailed
            ? "調整 MoA/verification timeout 或模型後重跑；先維持 paper-only，禁止真單與 broker write。"
            : "先修復 DMAD 降級原因後重跑 bridge；仍保持 paper-only。",
  };

  if (options.writeState === true) {
    await writeJsonWithSha(hermesOutPath, report);
    await writeJsonWithSha(openclawOutPath, report);
  }

  return { report, hermesOutPath, openclawOutPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const result = await runCapitalHolidayWeeklyFeedbackBridge({
    weeklyPath: argValue("--weekly", DEFAULT_WEEKLY_SIM_PATH),
    dmadPath: argValue("--dmad", DEFAULT_DMAD_RUN_PATH),
    hermesOutPath: argValue("--hermes-out", DEFAULT_HERMES_OUT),
    openclawOutPath: argValue("--openclaw-out", DEFAULT_OPENCLAW_OUT),
    writeState: hasFlag("--write-state"),
  });

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "OpenClaw Capital holiday weekly feedback bridge",
        `status=${result.report.status}`,
        `bestStrategy=${result.report.weeklySummary.bestStrategy}`,
        `dmadStatus=${result.report.dmadSummary.runStatus}`,
        `blockerCode=${result.report.blockerCode}`,
        "live/write/order=OFF",
      ].join("\n") + "\n",
    );
  }
}
