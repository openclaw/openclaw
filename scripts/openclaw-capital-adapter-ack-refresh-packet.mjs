#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCapitalAdapterAckHashHandoffVerifier } from "./openclaw-capital-adapter-ack-hash-handoff-verifier.mjs";

const SCHEMA = "openclaw.capital.adapter-ack-refresh-packet.v1";
const currentFile = fileURLToPath(import.meta.url);

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readTextOptional(filePath) {
  try {
    return { ok: true, text: await fs.readFile(filePath, "utf8"), error: "" };
  } catch (error) {
    return {
      ok: false,
      text: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function passFail(ok) {
  return ok ? "pass" : "fail";
}

function check(id, ok, evidence = {}) {
  return { id, status: passFail(ok), evidence };
}

function pnpmCommand(repoRoot, scriptName) {
  return `pnpm --dir ${path.resolve(repoRoot)} ${scriptName}`;
}

function isConcreteIsoTimestamp(value) {
  const text = safeString(value);
  return text.length > 0 && text !== "ISO-8601" && Number.isFinite(Date.parse(text));
}

function parseJson(text) {
  try {
    return JSON.parse(text.replace(/^\uFEFF/u, "").trim());
  } catch {
    return null;
  }
}

function renderMarkdown(report) {
  return [
    "# Capital Adapter Ack Refresh Packet",
    "",
    `status: ${report.status}`,
    `sealedIntentSha256: ${report.sealedIntentSha256 || "missing"}`,
    `sourcePath: ${report.refreshPacket.sourcePath || "missing"}`,
    `destinationPath: ${report.refreshPacket.destinationPath || "missing"}`,
    `currentContentSha256: ${report.refreshPacket.currentContentSha256 || "missing"}`,
    `candidateContentSha256: ${report.refreshPacket.candidateContentSha256 || "missing"}`,
    `candidateRollbackVerifiedAt: ${report.refreshPacket.candidateRollbackVerifiedAt || "missing"}`,
    `noLiveOrderSent: ${report.safety.noLiveOrderSent}`,
    `machineLine: ${report.machineLine}`,
    "",
    "## Checks",
    ...report.checks.map((item) => `- ${item.id}: ${item.status}`),
    "",
    "## Blockers",
    ...(report.blockers.length > 0 ? report.blockers.map((item) => `- ${item}`) : ["- none"]),
    "",
    `nextSafeTask: ${report.nextSafeTask}`,
    "",
  ].join("\n");
}

export async function buildCapitalAdapterAckRefreshPacket(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const stagingRoot = path.join(tradingRoot, "staging");
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const handoff =
    options.handoff ?? (await buildCapitalAdapterAckHashHandoffVerifier({ repoRoot, generatedAt }));
  const sourcePath = safeString(
    handoff.operatorHandoff?.sourcePath || handoff.paths?.stagedCandidateAckPath,
  );
  const destinationPath = safeString(
    handoff.operatorHandoff?.destinationPath || handoff.paths?.activeAckPath,
  );
  const sourceRead =
    typeof options.sourceText === "string"
      ? { ok: true, text: options.sourceText, error: "" }
      : await readTextOptional(sourcePath);
  const destinationRead =
    typeof options.destinationText === "string"
      ? { ok: true, text: options.destinationText, error: "" }
      : await readTextOptional(destinationPath);
  const candidateAck = parseJson(sourceRead.text);
  const activeAck = parseJson(destinationRead.text);
  const candidateSealedIntentSha256 = safeString(candidateAck?.sealedIntentSha256);
  const activeSealedIntentSha256 = safeString(activeAck?.sealedIntentSha256);
  const sealedIntentSha256 = safeString(handoff.sealedIntentSha256);
  const candidateRollbackVerifiedAt = safeString(
    candidateAck?.rollback?.verifiedAt || handoff.operatorHandoff?.candidateRollbackVerifiedAt,
  );
  const candidateContentSha256 = sourceRead.ok ? sha256Text(sourceRead.text) : "";
  const currentContentSha256 = destinationRead.ok ? sha256Text(destinationRead.text) : "";
  const packetPath = path.join(
    stagingRoot,
    "capital-external-broker-adapter-ack-refresh-packet.json",
  );
  const reportPath = path.join(
    stateRoot,
    "openclaw-capital-adapter-ack-refresh-packet-latest.json",
  );
  const markdownPath = path.join(
    stateRoot,
    "openclaw-capital-adapter-ack-refresh-packet-latest.md",
  );
  const panelPath = path.join(tradingRoot, "capital-adapter-ack-refresh-packet.json");
  const backupPath = path.join(
    stagingRoot,
    `capital-external-broker-adapter-ack.active-backup-${currentContentSha256 || "missing"}.json`,
  );
  const validationCommands = {
    handoff: pnpmCommand(repoRoot, "capital:trade:adapter-ack-handoff:check"),
    adapterAck: pnpmCommand(repoRoot, "capital:trade:adapter-ack:check"),
    liveReadiness: pnpmCommand(repoRoot, "capital:live-readiness:check"),
  };
  const handoffReady = handoff.status === "ready_for_operator_handoff";
  const noRefreshRequired =
    handoff.status === "verified_no_handoff_required" &&
    activeSealedIntentSha256.length > 0 &&
    activeSealedIntentSha256 === sealedIntentSha256;
  const handoffSatisfied = handoffReady || noRefreshRequired;
  const activeHashInExpectedState = noRefreshRequired
    ? activeSealedIntentSha256 === sealedIntentSha256
    : activeSealedIntentSha256 !== sealedIntentSha256;
  const checks = [
    check("handoff:ready", handoffSatisfied, {
      status: handoff.status,
      noRefreshRequired,
    }),
    check("source:readable", sourceRead.ok, { sourcePath, error: sourceRead.error }),
    check("destination:readable", destinationRead.ok, {
      destinationPath,
      error: destinationRead.error,
    }),
    check("source:json", candidateAck !== null, { sourcePath }),
    check("destination:json", activeAck !== null, { destinationPath }),
    check(
      "hash:candidate-matches-sealed-intent",
      candidateSealedIntentSha256 === sealedIntentSha256,
      {
        candidateSealedIntentSha256,
        sealedIntentSha256,
      },
    ),
    check("hash:active-still-mismatched", activeHashInExpectedState, {
      activeSealedIntentSha256,
      sealedIntentSha256,
      noRefreshRequired,
    }),
    check("rollback:candidate-concrete", isConcreteIsoTimestamp(candidateRollbackVerifiedAt), {
      candidateRollbackVerifiedAt,
    }),
    check("safety:no-live-order-sent", handoff.safety?.noLiveOrderSent === true, {
      noLiveOrderSent: handoff.safety?.noLiveOrderSent === true,
    }),
    check("safety:active-ack-write-suppressed", true, { wroteActiveAdapterAck: false }),
  ];
  const blockers = checks.filter((item) => item.status !== "pass").map((item) => item.id);
  const status = noRefreshRequired
    ? "no_refresh_required"
    : blockers.length === 0
      ? "ready_for_operator_adapter_apply"
      : "blocked";
  const refreshPacket = {
    schema: "openclaw.capital.external-broker-adapter-ack-refresh-packet.v1",
    status,
    generatedAt,
    owner: "operator-owned-broker-adapter-only",
    sourcePath,
    destinationPath,
    backupPath,
    sealedIntentSha256,
    activeSealedIntentSha256,
    candidateSealedIntentSha256,
    currentContentSha256,
    candidateContentSha256,
    candidateRollbackVerifiedAt,
    atomicApplyPlan: noRefreshRequired
      ? ["no_refresh_required_active_ack_already_matches_sealed_intent"]
      : [
          "read_destination_and_verify_current_content_sha256",
          "copy_destination_to_backup_path",
          "write_candidate_to_destination_path_using_atomic_replace",
          "rerun_adapter_ack_check",
          "rerun_live_readiness_check",
        ],
    validationCommands,
    safety: {
      packetOnly: true,
      wroteActiveAdapterAck: false,
      brokerWriteAttempted: false,
      sentOrder: false,
      noLiveOrderSent: true,
    },
  };
  const machineLine = [
    `capitalAdapterAckRefreshPacket=${status}`,
    `sha256=${sealedIntentSha256 || "missing"}`,
    `candidateContentSha256=${candidateContentSha256 || "missing"}`,
    `currentContentSha256=${currentContentSha256 || "missing"}`,
    "noOrderWrite=true",
    "sentOrder=false",
    `blockers=${blockers.length}`,
  ].join(" ");

  return {
    schema: SCHEMA,
    generatedAt,
    status,
    mode: "operator_adapter_refresh_packet_report_only",
    sealedIntentSha256,
    machineLine,
    refreshPacket,
    checks,
    blockers,
    safety: {
      generatedPacketOnly: true,
      wroteActiveAdapterAck: false,
      brokerWriteAttempted: false,
      writeBrokerOrders: false,
      liveTradingEnabled: false,
      sentOrder: false,
      noLiveOrderSent: true,
      no_live_order_sent: true,
    },
    paths: {
      packetPath,
      reportPath,
      markdownPath,
      panelPath,
      handoffReportPath: handoff.paths?.reportPath || "",
      sourcePath,
      destinationPath,
      backupPath,
    },
    nextSafeTask:
      status === "ready_for_operator_adapter_apply"
        ? `operator-owned adapter applies ${packetPath}; then rerun ${validationCommands.adapterAck}.`
        : status === "no_refresh_required"
          ? `active ack already matches sealed intent; skip refresh and rerun ${validationCommands.liveReadiness}.`
          : "Fix packet blockers before operator-owned adapter apply.",
  };
}

async function main() {
  const report = await buildCapitalAdapterAckRefreshPacket({ repoRoot: process.cwd() });

  if (hasFlag("--write-state") || hasFlag("--check")) {
    await writeJsonWithSha(report.paths.packetPath, report.refreshPacket);
    await writeJsonWithSha(report.paths.reportPath, report);
    await writeJsonWithSha(report.paths.panelPath, report);
    await writeTextWithSha(report.paths.markdownPath, renderMarkdown(report));
  }

  if (
    hasFlag("--check") &&
    (report.safety.sentOrder ||
      report.safety.brokerWriteAttempted ||
      report.safety.wroteActiveAdapterAck)
  ) {
    throw new Error("CAPITAL_ADAPTER_ACK_REFRESH_PACKET_UNSAFE_WRITE");
  }

  if (hasFlag("--json") || hasFlag("--check")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${report.machineLine}\nnextSafeTask=${report.nextSafeTask}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(
      `capital adapter ack refresh packet failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
