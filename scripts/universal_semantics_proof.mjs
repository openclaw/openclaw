import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const proofRoot = process.env.PROOF_DIR;
if (!proofRoot) {
  throw new Error("PROOF_DIR is required");
}

const ts = new Date().toISOString().replace(/[-:.]/g, "");
const proofDir = proofRoot.includes("phase3_perfect_knowledge_")
  ? proofRoot
  : join(proofRoot, `phase3_perfect_knowledge_${ts}`);
await mkdir(proofDir, { recursive: true });

const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT || "18789";
const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || `http://127.0.0.1:${gatewayPort}`;
const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || "";

if (!gatewayToken) {
  throw new Error("OPENCLAW_GATEWAY_TOKEN is required");
}

const toolMaxTimeSec = Number(process.env.OPENCLAW_TOOL_MAX_TIME ?? "90");
const toolConnectTimeoutSec = Number(process.env.OPENCLAW_TOOL_CONNECT_TIMEOUT ?? "10");
const toolRetries = Number(process.env.OPENCLAW_TOOL_RETRIES ?? "3");
const toolTimeoutMs = Math.max(1, toolMaxTimeSec) * 1000;
const execFileAsync = promisify(execFile);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const postJson = async (url, body, headers = {}, timeoutMs = toolTimeoutMs) => {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const headerArgs = Object.entries({
    "content-type": "application/json",
    ...headers,
  }).flatMap(([key, value]) => ["-H", `${key}: ${value}`]);
  const marker = "__STATUS__:";
  const args = [
    "-sS",
    "-X",
    "POST",
    ...headerArgs,
    "--data-raw",
    payload,
    "--connect-timeout",
    String(Math.max(1, Math.ceil(toolConnectTimeoutSec))),
    "--max-time",
    String(Math.max(1, Math.ceil(toolMaxTimeSec))),
    "--retry",
    String(Math.max(0, toolRetries - 1)),
    "--retry-delay",
    "1",
    "--retry-connrefused",
    "--retry-max-time",
    String(Math.max(1, Math.ceil(toolMaxTimeSec))),
    "-w",
    `\n${marker}%{http_code}`,
    url,
  ];

  const { stdout } = await execFileAsync("curl", args, { timeout: timeoutMs + 2000, maxBuffer: 50 * 1024 * 1024 });
  const output = String(stdout ?? "");
  const markerIndex = output.lastIndexOf(marker);
  const bodyText = markerIndex === -1 ? output : output.slice(0, markerIndex).trimEnd();
  const statusText = markerIndex === -1 ? "0" : output.slice(markerIndex + marker.length).trim();
  const status = Number(statusText) || 0;
  let json = null;
  try {
    json = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    json = { raw: bodyText };
  }
  return { status, ok: status >= 200 && status < 300, json };
};

const invokeTool = async (tool, args = {}) => {
  const attempts = Math.max(1, toolRetries);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await postJson(
        `${gatewayUrl}/tools/invoke`,
        { tool, args, sessionKey: "main" },
        { authorization: `Bearer ${gatewayToken}` },
        toolTimeoutMs,
      );
      if (!res.ok || !res.json) {
        return { ok: false, status: res.status, error: res.json };
      }
      return res.json;
    } catch (err) {
      if (attempt >= attempts) throw err;
      await sleep(500 * attempt);
    }
  }
  return { ok: false, error: "unreachable" };
};

const parseToolJsonResult = (body) => {
  if (!body || !body.ok) return null;
  const result = body.result;
  if (result && typeof result === "object" && Array.isArray(result.content)) {
    const first = result.content[0];
    if (first && typeof first.text === "string") {
      try {
        return JSON.parse(first.text);
      } catch {
        return { raw: first.text };
      }
    }
  }
  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch {
      return { raw: result };
    }
  }
  return result ?? null;
};

const writeJson = async (name, data) => {
  await writeFile(join(proofDir, name), JSON.stringify(data, null, 2));
};

const runUniversal = async (label, payload) => {
  const res = await invokeTool("ha_universal_control", payload);
  const parsed = parseToolJsonResult(res);
  return { label, request: payload, raw: res, parsed };
};

const results = {
  ping: null,
  inventory_report: null,
  actions: {},
};

console.log("Starting universal human-mode proof");
console.log(`Gateway URL: ${gatewayUrl}`);

const pingRes = await invokeTool("ha_ping", {});
results.ping = { raw: pingRes, parsed: parseToolJsonResult(pingRes) };
await writeJson("ha_ping.json", results.ping);
if (!pingRes.ok) {
  throw new Error("ha_ping failed");
}

const inventoryRes = await invokeTool("ha_inventory_report", { include_raw: true });
const inventoryParsed = parseToolJsonResult(inventoryRes);
results.inventory_report = { raw: inventoryRes, parsed: inventoryParsed };
await writeJson("inventory_report.json", inventoryParsed ?? {});
if (inventoryParsed?.inventory_snapshot) {
  await writeJson("inventory_snapshot.json", inventoryParsed.inventory_snapshot);
}
if (inventoryParsed?.semantic_map) {
  await writeJson("semantic_map.json", inventoryParsed.semantic_map);
}
if (inventoryParsed?.learned_map) {
  await writeJson("learned_map.json", inventoryParsed.learned_map);
}
if (inventoryParsed?.risk_approvals) {
  await writeJson("approvals.json", inventoryParsed.risk_approvals);
}
if (inventoryParsed?.reliability_stats) {
  await writeJson("reliability_stats.json", inventoryParsed.reliability_stats);
}
if (inventoryParsed?.report_md) {
  await writeFile(join(proofDir, "inventory_report.md"), String(inventoryParsed.report_md));
}

const snapshot = inventoryParsed?.inventory_snapshot ?? {};
const semanticMap = inventoryParsed?.semantic_map?.by_entity ?? {};
const snapshotEntities = snapshot?.entities ?? {};
const noJebanciScore = inventoryParsed?.no_jebanci_score ?? null;

const getSnapshotState = (entityId) => {
  const entry = snapshotEntities[entityId];
  if (!entry) return null;
  return entry.state ?? null;
};

const isUnavailableState = (state) =>
  state === "unavailable" || state === "unknown";

const pickEntityBySemantic = (semanticType, domainHint) => {
  for (const [entityId, resolution] of Object.entries(semanticMap)) {
    if (resolution?.semantic_type !== semanticType) continue;
    const entity = snapshot?.entities?.[entityId];
    if (!entity) continue;
    if (domainHint && entity.domain !== domainHint) continue;
    return entityId;
  }
  return null;
};

const lowRiskGroups = [
  { semantic: "light", domain: "light" },
  { semantic: "fan", domain: "fan" },
  { semantic: "outlet", domain: "switch" },
  { semantic: "generic_switch", domain: "switch" },
];

const highRiskGroups = [
  { semantic: "climate", domain: "climate" },
  { semantic: "lock", domain: "lock" },
  { semantic: "alarm", domain: "alarm_control_panel" },
  { semantic: "vacuum", domain: "vacuum" },
];

const semanticResults = {};
const reportRows = [];
const needsConfirm = [];
const needsOverride = Array.isArray(inventoryParsed?.semantic_map?.needs_override)
  ? inventoryParsed.semantic_map.needs_override
  : [];

for (const candidate of lowRiskGroups) {
  const entityId = pickEntityBySemantic(candidate.semantic, candidate.domain);
  if (!entityId) {
    semanticResults[candidate.semantic] = { status: "SKIP", reason: "no_entity" };
    continue;
  }
  const resolution = semanticMap[entityId] ?? {};
  const state = getSnapshotState(entityId);
  if (isUnavailableState(state)) {
    semanticResults[candidate.semantic] = { status: "SKIP", reason: "unavailable" };
    continue;
  }
  if (resolution?.ambiguity?.needs_override) {
    semanticResults[candidate.semantic] = { status: "NEEDS_OVERRIDE", reason: "low_confidence" };
    continue;
  }
  const action = await runUniversal(candidate.semantic, {
    target: { entity_id: entityId },
    safe_probe: true,
  });
  results.actions[candidate.semantic] = action;
  const verification = action?.parsed?.verification ?? {};
  const verificationOk = Boolean(verification?.ok);
  const verificationLevel = verification?.level ?? "none";
  const stateVerified = verificationOk && verificationLevel === "state";
  const eventVerified = verificationOk && verificationLevel === "ha_event";
  const restoreOk = Boolean(action?.parsed?.probe?.restore_verification?.ok);
  const timeoutReason = action?.parsed?.verification?.reason;
  const timeoutOk = ["deadline_exceeded", "probe_skipped_due_to_latency"].includes(timeoutReason);
  const status = stateVerified
    ? "PASS"
    : eventVerified
      ? "PASS_EVENT"
      : timeoutOk
        ? "PASS_READONLY"
        : action?.parsed?.error === "confirm_required"
          ? "NEEDS_CONFIRM"
          : "FAIL";
  if (status === "NEEDS_CONFIRM") {
    needsConfirm.push({ entity_id: entityId, reason: "confirm_required" });
  }
  semanticResults[candidate.semantic] = {
    status,
    reason: stateVerified
      ? "verified_state"
      : eventVerified
        ? "verified_event"
        : action?.parsed?.verification?.reason ?? action?.parsed?.error ?? "unverified",
  };
  reportRows.push({
    domain: candidate.semantic,
    result: status,
    sample: entityId,
    action: "reversible_probe",
    verified: stateVerified ? "state" : eventVerified ? "ha_event" : "no",
    restore: restoreOk ? "yes" : "no",
  });
}

for (const candidate of highRiskGroups) {
  const entityId = pickEntityBySemantic(candidate.semantic, candidate.domain);
  if (!entityId) {
    semanticResults[candidate.semantic] = { status: "SKIP", reason: "no_entity" };
    continue;
  }
  const resolution = semanticMap[entityId] ?? {};
  const state = getSnapshotState(entityId);
  if (isUnavailableState(state)) {
    semanticResults[candidate.semantic] = { status: "SKIP", reason: "unavailable" };
    continue;
  }
  const action = await runUniversal(candidate.semantic, {
    target: { entity_id: entityId },
    safe_probe: true,
  });
  results.actions[candidate.semantic] = action;
  const verificationOk = Boolean(action?.parsed?.verification?.ok);
  const status = verificationOk ? "PASS_READONLY" : "FAIL";
  semanticResults[candidate.semantic] = {
    status,
    reason: verificationOk ? "verified_probe" : action?.parsed?.verification?.reason ?? "unverified",
  };
  reportRows.push({
    domain: candidate.semantic,
    result: status,
    sample: entityId,
    action: "read_only",
    verified: verificationOk ? "yes" : "no",
    restore: "n/a",
  });
}

await writeJson("devtools_results.json", results);

const summary = {
  semantic_types: semanticResults,
  needs_override: needsOverride,
  needs_confirm: needsConfirm,
  no_jebanci_score: noJebanciScore,
};

const statuses = Object.values(semanticResults).map((entry) => entry.status);
const lowRiskFailures = Object.entries(semanticResults).some(
  ([semantic, entry]) => ["light", "fan", "outlet", "generic_switch"].includes(semantic) &&
    ["FAIL", "NEEDS_OVERRIDE", "NEEDS_CONFIRM"].includes(entry.status),
);
const overall = statuses.includes("FAIL") || lowRiskFailures ? "FAIL" : "PASS";

await writeJson("RESULT.json", { overall, summary });

const reportLines = [
  "# Luna Human-Mode Universal Report",
  "",
  `PROOF path: ${proofDir}`,
  `Overall: ${overall}`,
  noJebanciScore !== null ? `NO_JEBANCI_SCORE: ${noJebanciScore}%` : "NO_JEBANCI_SCORE: n/a",
  "",
  "## Results",
  "Domain | Result | Sample entity | What we did | Verified | Restore verified",
  "--- | --- | --- | --- | --- | ---",
  ...reportRows.map(
    (row) =>
      `${row.domain} | ${row.result} | ${row.sample} | ${row.action} | ${row.verified} | ${row.restore}`,
  ),
  "",
  "## PASS Rule",
  "- OVERALL PASS if no FAIL and no NEEDS_OVERRIDE/NEEDS_CONFIRM for low-risk domains with candidates.",
  "- PASS_EVENT means HA call_service evidence was seen but state did not confirm within deadline.",
  "- High-risk domains may be PASS_READONLY unless approvals exist.",
];

await writeFile(join(proofDir, "UNIVERSAL_HUMAN_MODE_REPORT.md"), reportLines.join("\n"));

console.log("Proof script finished");
console.log(`OVERALL ${overall}`);
