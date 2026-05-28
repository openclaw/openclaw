#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCapitalAdapterAckRefreshPacket } from "./openclaw-capital-adapter-ack-refresh-packet.mjs";

const SCHEMA = "openclaw.capital.adapter-ack-operator-apply-verifier.v1";
const PACKET_SCHEMA = "openclaw.capital.external-broker-adapter-ack-refresh-packet.v1";
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

async function readJsonOptional(filePath) {
  const read = await readTextOptional(filePath);
  if (!read.ok) {
    return { ok: false, value: null, text: "", error: read.error };
  }
  try {
    return {
      ok: true,
      value: JSON.parse(read.text.replace(/^\uFEFF/u, "").trim()),
      text: read.text,
      error: "",
    };
  } catch (error) {
    return {
      ok: false,
      value: null,
      text: read.text,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseJson(text) {
  try {
    return JSON.parse(
      String(text || "")
        .replace(/^\uFEFF/u, "")
        .trim(),
    );
  } catch {
    return null;
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

function isRepoRootPnpmCommand(command) {
  return /^pnpm --dir .+ /u.test(safeString(command));
}

function isConcreteIsoTimestamp(value) {
  const text = safeString(value);
  return text.length > 0 && text !== "ISO-8601" && Number.isFinite(Date.parse(text));
}

function renderMarkdown(report) {
  return [
    "# Capital Adapter Ack Operator Apply Verifier",
    "",
    `status: ${report.status}`,
    `sealedIntentSha256: ${report.sealedIntentSha256 || "missing"}`,
    `activeState: ${report.applyVerdict.activeState}`,
    `operatorMayApply: ${report.applyVerdict.operatorMayApply}`,
    `operatorApplyVerified: ${report.applyVerdict.operatorApplyVerified}`,
    `destinationContentSha256: ${report.applyVerdict.destinationContentSha256 || "missing"}`,
    `candidateContentSha256: ${report.applyVerdict.candidateContentSha256 || "missing"}`,
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

async function resolvePacket({ repoRoot, generatedAt, packet, packetPath }) {
  const resolvedPacketPath = path.resolve(
    packetPath ||
      path.join(
        repoRoot,
        ".openclaw",
        "trading",
        "staging",
        "capital-external-broker-adapter-ack-refresh-packet.json",
      ),
  );
  if (packet && typeof packet === "object") {
    return { ok: true, value: packet, packetPath: resolvedPacketPath, error: "" };
  }
  const read = await readJsonOptional(resolvedPacketPath);
  if (read.ok) {
    return { ok: true, value: read.value, packetPath: resolvedPacketPath, error: "" };
  }
  const built = await buildCapitalAdapterAckRefreshPacket({ repoRoot, generatedAt });
  return {
    ok: true,
    value: built.refreshPacket,
    packetPath: built.paths.packetPath || resolvedPacketPath,
    error: "",
  };
}

export async function buildCapitalAdapterAckOperatorApplyVerifier(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const packetRead = await resolvePacket({
    repoRoot,
    generatedAt,
    packet: options.packet,
    packetPath: options.packetPath,
  });
  const packet = packetRead.value ?? {};
  const sourcePath = safeString(packet.sourcePath);
  const destinationPath = safeString(packet.destinationPath);
  const sourceRead =
    typeof options.sourceText === "string"
      ? { ok: true, text: options.sourceText, error: "" }
      : await readTextOptional(sourcePath);
  const destinationRead =
    typeof options.destinationText === "string"
      ? { ok: true, text: options.destinationText, error: "" }
      : await readTextOptional(destinationPath);
  const sourceAck = parseJson(sourceRead.text);
  const destinationAck = parseJson(destinationRead.text);
  const sealedIntentSha256 = safeString(packet.sealedIntentSha256);
  const sourceSealedIntentSha256 = safeString(sourceAck?.sealedIntentSha256);
  const destinationSealedIntentSha256 = safeString(destinationAck?.sealedIntentSha256);
  const sourceContentSha256 = sourceRead.ok ? sha256Text(sourceRead.text) : "";
  const destinationContentSha256 = destinationRead.ok ? sha256Text(destinationRead.text) : "";
  const candidateContentSha256 = safeString(packet.candidateContentSha256);
  const currentContentSha256 = safeString(packet.currentContentSha256);
  const activeMatchesPreApplyCurrent =
    destinationContentSha256.length > 0 && destinationContentSha256 === currentContentSha256;
  const activeMatchesCandidate =
    destinationContentSha256.length > 0 && destinationContentSha256 === candidateContentSha256;
  const activeState = activeMatchesCandidate
    ? "applied_candidate_matches"
    : activeMatchesPreApplyCurrent
      ? "pre_apply_current_matches"
      : "blocked_active_content_drift";
  const sourceContentMatchesPacket =
    sourceContentSha256.length > 0 && sourceContentSha256 === candidateContentSha256;
  const candidateMatchesSealedIntent =
    sourceSealedIntentSha256.length > 0 && sourceSealedIntentSha256 === sealedIntentSha256;
  const candidateRollbackVerifiedAt = safeString(packet.candidateRollbackVerifiedAt);
  const validationCommands = {
    refreshPacket: pnpmCommand(repoRoot, "capital:trade:adapter-ack-refresh-packet:check"),
    applyVerifier: pnpmCommand(repoRoot, "capital:trade:adapter-ack-apply-verifier:check"),
    adapterAck: pnpmCommand(repoRoot, "capital:trade:adapter-ack:check"),
    liveReadiness: pnpmCommand(repoRoot, "capital:live-readiness:check"),
  };
  const validationCommandsQualified =
    Object.values(validationCommands).every(isRepoRootPnpmCommand);
  const commonSafe =
    packetRead.ok === true &&
    packet.schema === PACKET_SCHEMA &&
    packet.owner === "operator-owned-broker-adapter-only" &&
    sourceRead.ok &&
    destinationRead.ok &&
    sourceAck !== null &&
    destinationAck !== null &&
    sourceContentMatchesPacket &&
    candidateMatchesSealedIntent &&
    isConcreteIsoTimestamp(candidateRollbackVerifiedAt) &&
    validationCommandsQualified &&
    packet.safety?.sentOrder !== true &&
    packet.safety?.brokerWriteAttempted !== true &&
    packet.safety?.wroteActiveAdapterAck !== true;
  const preApplyReady =
    commonSafe &&
    activeMatchesPreApplyCurrent &&
    destinationSealedIntentSha256 !== sealedIntentSha256;
  const appliedVerified =
    commonSafe && activeMatchesCandidate && destinationSealedIntentSha256 === sealedIntentSha256;
  const noApplyRequired =
    commonSafe &&
    packet.status === "no_refresh_required" &&
    activeMatchesPreApplyCurrent &&
    destinationSealedIntentSha256 === sealedIntentSha256;
  const status = appliedVerified
    ? "applied_verified"
    : preApplyReady
      ? "ready_for_operator_apply"
      : noApplyRequired
        ? "no_apply_required"
        : "blocked";
  const checks = [
    check("packet:present", packetRead.ok, {
      packetPath: packetRead.packetPath,
      error: packetRead.error,
    }),
    check("packet:schema", packet.schema === PACKET_SCHEMA, {
      expected: PACKET_SCHEMA,
      actual: packet.schema || "",
    }),
    check("packet:owner", packet.owner === "operator-owned-broker-adapter-only", {
      owner: packet.owner || "",
    }),
    check("source:readable", sourceRead.ok, { sourcePath, error: sourceRead.error }),
    check("destination:readable", destinationRead.ok, {
      destinationPath,
      error: destinationRead.error,
    }),
    check("source:json", sourceAck !== null, { sourcePath }),
    check("destination:json", destinationAck !== null, { destinationPath }),
    check("source:content-hash-matches-packet", sourceContentMatchesPacket, {
      sourceContentSha256,
      candidateContentSha256,
    }),
    check(
      "destination:matches-known-packet-state",
      activeMatchesPreApplyCurrent || activeMatchesCandidate,
      {
        destinationContentSha256,
        currentContentSha256,
        candidateContentSha256,
        activeState,
      },
    ),
    check("hash:candidate-matches-sealed-intent", candidateMatchesSealedIntent, {
      sourceSealedIntentSha256,
      sealedIntentSha256,
    }),
    check("rollback:candidate-concrete", isConcreteIsoTimestamp(candidateRollbackVerifiedAt), {
      candidateRollbackVerifiedAt,
    }),
    check("safety:packet-no-order", packet.safety?.sentOrder !== true, {
      packetSentOrder: packet.safety?.sentOrder === true,
    }),
    check("safety:write-suppressed", true, { wroteActiveAdapterAck: false }),
    check("commands:repo-root-qualified", validationCommandsQualified, validationCommands),
  ];
  const blockers = checks.filter((item) => item.status !== "pass").map((item) => item.id);
  const reportPath = path.join(
    stateRoot,
    "openclaw-capital-adapter-ack-operator-apply-verifier-latest.json",
  );
  const markdownPath = path.join(
    stateRoot,
    "openclaw-capital-adapter-ack-operator-apply-verifier-latest.md",
  );
  const panelPath = path.join(tradingRoot, "capital-adapter-ack-operator-apply-verifier.json");
  const applyVerdict = {
    status,
    activeState,
    operatorMayApply: status === "ready_for_operator_apply",
    operatorApplyVerified: status === "applied_verified",
    packetPath: packetRead.packetPath,
    sourcePath,
    destinationPath,
    backupPath: packet.backupPath || "",
    sealedIntentSha256,
    sourceSealedIntentSha256,
    destinationSealedIntentSha256,
    currentContentSha256,
    candidateContentSha256,
    sourceContentSha256,
    destinationContentSha256,
    candidateRollbackVerifiedAt,
    validationCommands,
  };
  const machineLine = [
    `capitalAdapterAckOperatorApply=${status}`,
    `sha256=${sealedIntentSha256 || "missing"}`,
    `activeState=${activeState}`,
    `operatorMayApply=${status === "ready_for_operator_apply"}`,
    `operatorApplyVerified=${status === "applied_verified"}`,
    "noOrderWrite=true",
    "sentOrder=false",
    `blockers=${blockers.length}`,
  ].join(" ");

  return {
    schema: SCHEMA,
    generatedAt,
    status,
    mode: "operator_owned_adapter_apply_verifier_report_only",
    sealedIntentSha256,
    machineLine,
    applyVerdict,
    checks,
    blockers,
    safety: {
      generatedReportOnly: true,
      wroteActiveAdapterAck: false,
      brokerWriteAttempted: false,
      writeBrokerOrders: false,
      liveTradingEnabled: false,
      sentOrder: false,
      noLiveOrderSent: true,
      no_live_order_sent: true,
    },
    paths: {
      reportPath,
      markdownPath,
      panelPath,
      packetPath: packetRead.packetPath,
      sourcePath,
      destinationPath,
    },
    nextSafeTask:
      status === "applied_verified"
        ? `Adapter ack is applied; rerun ${validationCommands.adapterAck} and ${validationCommands.liveReadiness}.`
        : status === "ready_for_operator_apply"
          ? `operator-owned adapter applies ${packetRead.packetPath}; then rerun ${validationCommands.applyVerifier}.`
          : status === "no_apply_required"
            ? `active ack already matches sealed intent; skip operator apply and rerun ${validationCommands.liveReadiness}.`
            : "Fix operator apply verifier blockers before active ack refresh.",
  };
}

async function main() {
  const report = await buildCapitalAdapterAckOperatorApplyVerifier({ repoRoot: process.cwd() });

  if (hasFlag("--write-state") || hasFlag("--check")) {
    await writeJsonWithSha(report.paths.reportPath, report);
    await writeJsonWithSha(report.paths.panelPath, report);
    await writeTextWithSha(report.paths.markdownPath, renderMarkdown(report));
  }

  if (
    hasFlag("--check") &&
    (report.safety.sentOrder === true ||
      report.safety.brokerWriteAttempted === true ||
      report.safety.wroteActiveAdapterAck === true)
  ) {
    throw new Error("CAPITAL_ADAPTER_ACK_OPERATOR_APPLY_VERIFIER_UNSAFE_WRITE");
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
      `capital adapter ack operator apply verifier failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
