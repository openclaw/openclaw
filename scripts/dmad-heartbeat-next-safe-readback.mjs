#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NEXT_SAFE_SCRIPT = "scripts/openclaw-controlled-task-runner.mjs";
const REPORT_SCHEMA = "openclaw.dmad.heartbeat-next-safe-readback.v1";
const HEARTBEAT_AUTOMATION_ID = "evaluate-openclaw-dmad-stability-and-improvements";
const STATE_DIR_REL = "reports/hermes-agent/state";
export const HEARTBEAT_NEXT_SAFE_READBACK_REPORT_REL = `${STATE_DIR_REL}/openclaw-dmad-heartbeat-next-safe-readback-latest.json`;
const REQUIRED_TOKENS = ["nextSafe=", "dmadGate=", "dmadPublish=", "readOnly=true"];
const REPORT_MODES = new Set(["state_write", "no_write"]);
const REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function normalizeText(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseKeyValueLine(output, key) {
  const prefix = `${key}=`;
  for (const line of String(output ?? "").split(/\r?\n/)) {
    if (line.startsWith(prefix)) {
      return normalizeText(line.slice(prefix.length));
    }
  }
  return null;
}

function normalizeReportMode(mode) {
  return REPORT_MODES.has(mode) ? mode : "state_write";
}

function escapeXmlText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildHeartbeatSummary({ nextSafe, status, freshnessStatus, mode, blockedReason }) {
  const dispatchable = status === "ready" && freshnessStatus === "ok" && Boolean(nextSafe);
  const decision = dispatchable ? "NOTIFY" : "DONT_NOTIFY";
  const messageParts = [
    `next_safe=${nextSafe ?? ""}`,
    `status=${status}`,
    `freshness=${freshnessStatus}`,
    `mode=${mode}`,
    `dispatchable=${String(dispatchable)}`,
  ];
  if (!dispatchable) {
    messageParts.push(`blocked_reason=${blockedReason ?? "not_ready"}`);
  }
  const message = messageParts.join(";");
  return {
    automationId: HEARTBEAT_AUTOMATION_ID,
    decision,
    nextSafe,
    dispatchable,
    message,
    xml: [
      "<heartbeat>",
      `  <automation_id>${escapeXmlText(HEARTBEAT_AUTOMATION_ID)}</automation_id>`,
      `  <decision>${decision}</decision>`,
      `  <message>${escapeXmlText(message)}</message>`,
      "</heartbeat>",
    ].join("\n"),
  };
}

function buildGeneratedAtFreshness(
  generatedAt,
  { now = new Date(), maxAgeMs = REPORT_MAX_AGE_MS } = {},
) {
  const timestampMs = Date.parse(generatedAt);
  if (!Number.isFinite(timestampMs)) {
    return {
      status: "blocked",
      ageMs: null,
      maxAgeMs,
      reason: "generatedAt_invalid",
    };
  }
  const ageMs = now.getTime() - timestampMs;
  if (ageMs < 0) {
    return {
      status: "blocked",
      ageMs,
      maxAgeMs,
      reason: `generatedAt_future_ageMs=${ageMs}`,
    };
  }
  if (ageMs > maxAgeMs) {
    return {
      status: "blocked",
      ageMs,
      maxAgeMs,
      reason: `generatedAt_ageMs=${ageMs}_exceeds_${maxAgeMs}`,
    };
  }
  return {
    status: "ok",
    ageMs,
    maxAgeMs,
    reason: null,
  };
}

export function readMachineLineFromPlainOutput(output) {
  return parseKeyValueLine(output, "machine_line");
}

export function readNextSafeFromMachineLine(machineLine) {
  for (const token of String(machineLine ?? "").split(";")) {
    const trimmed = token.trim();
    if (trimmed.startsWith("nextSafe=")) {
      return normalizeText(trimmed.slice("nextSafe=".length));
    }
  }
  return null;
}

export function buildMachineLineFromJsonPayload(payload) {
  const topLevel = normalizeText(payload?.machineLine);
  if (topLevel) {
    return topLevel;
  }

  const taskId = normalizeText(payload?.task?.id);
  const dmadGate = normalizeText(payload?.dmad_validation_hint?.machineLine);
  const dmadPublish = normalizeText(payload?.dmad_publish_status?.machineLine);
  if (!taskId || !dmadGate || !dmadPublish) {
    return null;
  }
  return [
    `nextSafe=${taskId}`,
    dmadGate,
    dmadPublish,
    `readOnly=${String(payload?.readOnlyMode === true)}`,
  ].join(";");
}

export function validateHeartbeatMachineLine(machineLine) {
  const value = normalizeText(machineLine);
  if (!value) {
    return { ok: false, missing: ["machine_line"] };
  }
  const missing = REQUIRED_TOKENS.filter((token) => !value.includes(token));
  return { ok: missing.length === 0, missing };
}

export function buildHeartbeatNextSafeReadbackReport(
  readback,
  now = new Date(),
  { mode = "state_write", freshnessNow = now, maxAgeMs = REPORT_MAX_AGE_MS } = {},
) {
  const validation = validateHeartbeatMachineLine(readback?.machineLine);
  const generatedAt = now.toISOString();
  const machineLine = normalizeText(readback?.machineLine) ?? "";
  const nextSafe = readNextSafeFromMachineLine(machineLine);
  const freshness = buildGeneratedAtFreshness(generatedAt, { now: freshnessNow, maxAgeMs });
  const modeValue = normalizeReportMode(mode);
  const status = validation.ok && freshness.status === "ok" ? "ready" : "blocked";
  const blockedReason = validation.ok
    ? freshness.reason
    : `missingTokens=${validation.missing.join("/")}`;
  const heartbeat = buildHeartbeatSummary({
    nextSafe,
    status,
    freshnessStatus: freshness.status,
    mode: modeValue,
    blockedReason,
  });
  return {
    schema: REPORT_SCHEMA,
    generatedAt,
    mode: modeValue,
    status,
    source: normalizeText(readback?.source) ?? "unknown",
    nextSafe,
    heartbeat,
    automationReadPoint: {
      source: "latest_artifact",
      artifact: HEARTBEAT_NEXT_SAFE_READBACK_REPORT_REL,
      selector: "heartbeat.xml",
      nextSafe,
      dispatchable: heartbeat.dispatchable,
      stdoutRequired: false,
      blockedReason: heartbeat.dispatchable ? null : blockedReason,
      message: heartbeat.message,
      xml: heartbeat.xml,
    },
    machineLine,
    fallbackReason: normalizeText(readback?.fallbackReason),
    blockedReason,
    plainExitCode: Number.isFinite(readback?.plainExitCode) ? readback.plainExitCode : null,
    jsonExitCode: Number.isFinite(readback?.jsonExitCode) ? readback.jsonExitCode : null,
    readOnly: validation.ok && String(readback?.machineLine).includes("readOnly=true"),
    validation: {
      ok: validation.ok,
      requiredTokens: REQUIRED_TOKENS,
      missingTokens: validation.missing,
    },
    freshness,
    safety: {
      readOnly: true,
      noBrokerWrite: true,
      noExternalWrite: true,
    },
    reportPath: HEARTBEAT_NEXT_SAFE_READBACK_REPORT_REL,
  };
}

export async function writeHeartbeatNextSafeReadbackReport(repoRoot, report) {
  const reportPath = path.join(repoRoot, HEARTBEAT_NEXT_SAFE_READBACK_REPORT_REL);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return HEARTBEAT_NEXT_SAFE_READBACK_REPORT_REL;
}

export function readMachineLineFromJsonOutput(output) {
  const text = normalizeText(output);
  if (!text) {
    return null;
  }
  try {
    return buildMachineLineFromJsonPayload(JSON.parse(text));
  } catch {
    return null;
  }
}

function runControlledNextSafe(repoRoot, { json = false } = {}) {
  const args = [NEXT_SAFE_SCRIPT, "--next-safe"];
  if (json) {
    args.push("--json");
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", (error) => {
      resolve({
        exitCode: 1,
        stdout: stdout.join(""),
        stderr: `${stderr.join("")}${String(error?.message ?? error)}`,
      });
    });
    child.on("exit", (code) => {
      resolve({
        exitCode: typeof code === "number" ? code : 1,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
      });
    });
  });
}

export async function readHeartbeatNextSafeMachineLine({
  repoRoot = process.cwd(),
  runNextSafe = runControlledNextSafe,
} = {}) {
  const plain = await runNextSafe(repoRoot, { json: false });
  const plainMachineLine = readMachineLineFromPlainOutput(plain.stdout);
  const plainValidation = validateHeartbeatMachineLine(plainMachineLine);
  if (plain.exitCode === 0 && plainValidation.ok) {
    return {
      source: "plain_machine_line",
      machineLine: plainMachineLine,
      plainExitCode: plain.exitCode,
      jsonExitCode: null,
      fallbackReason: null,
    };
  }

  const json = await runNextSafe(repoRoot, { json: true });
  const jsonMachineLine = readMachineLineFromJsonOutput(json.stdout);
  const jsonValidation = validateHeartbeatMachineLine(jsonMachineLine);
  if (json.exitCode === 0 && jsonValidation.ok) {
    return {
      source: "json_fallback",
      machineLine: jsonMachineLine,
      plainExitCode: plain.exitCode,
      jsonExitCode: json.exitCode,
      fallbackReason:
        plain.exitCode === 0
          ? `plain_missing=${plainValidation.missing.join("/")}`
          : `plain_exit=${plain.exitCode}`,
    };
  }

  throw new Error(
    [
      "DMAD heartbeat next-safe readback failed",
      `plainExit=${plain.exitCode}`,
      `plainMissing=${plainValidation.missing.join("/")}`,
      `jsonExit=${json.exitCode}`,
      `jsonMissing=${jsonValidation.missing.join("/")}`,
    ].join(";"),
  );
}

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    writeState: !argv.includes("--no-write-state"),
  };
}

export async function runHeartbeatNextSafeReadbackCli({
  argv = [],
  repoRoot = process.cwd(),
  runNextSafe = runControlledNextSafe,
  writeReport = writeHeartbeatNextSafeReadbackReport,
  stdout = process.stdout,
  now,
  freshnessNow,
  maxAgeMs,
} = {}) {
  const options = parseArgs(argv);
  const readback = await readHeartbeatNextSafeMachineLine({ repoRoot, runNextSafe });
  const report = buildHeartbeatNextSafeReadbackReport(readback, now, {
    mode: options.writeState ? "state_write" : "no_write",
    freshnessNow,
    maxAgeMs,
  });
  if (options.writeState) {
    await writeReport(repoRoot, report);
  }
  if (options.json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  }
  stdout.write(`machine_line=${report.machineLine}\n`);
  stdout.write(`next_safe=${report.nextSafe ?? ""}\n`);
  stdout.write(`source=${report.source}\n`);
  stdout.write(`mode=${report.mode}\n`);
  stdout.write(`status=${report.status}\n`);
  stdout.write(`dispatchable=${String(report.automationReadPoint.dispatchable)}\n`);
  stdout.write(`generated_at=${report.generatedAt}\n`);
  stdout.write(`freshness=${report.freshness.status}\n`);
  stdout.write(`freshness_age_ms=${report.freshness.ageMs}\n`);
  stdout.write(`freshness_max_age_ms=${report.freshness.maxAgeMs}\n`);
  if (report.freshness.reason) {
    stdout.write(`freshness_reason=${report.freshness.reason}\n`);
  }
  if (report.blockedReason) {
    stdout.write(`blocked_reason=${report.blockedReason}\n`);
  }
  if (report.automationReadPoint.blockedReason) {
    stdout.write(`dispatch_blocked_reason=${report.automationReadPoint.blockedReason}\n`);
  }
  stdout.write(`report=${report.reportPath}\n`);
  if (report.fallbackReason) {
    stdout.write(`fallback_reason=${report.fallbackReason}\n`);
  }
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  await runHeartbeatNextSafeReadbackCli({ argv });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentPath = fileURLToPath(import.meta.url);
if (invokedPath === currentPath) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
}
