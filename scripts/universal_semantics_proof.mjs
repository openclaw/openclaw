import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const proofDir = process.env.PROOF_DIR;
if (!proofDir) {
  throw new Error("PROOF_DIR is required");
}

await mkdir(proofDir, { recursive: true });

const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT || "18789";
const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || `http://127.0.0.1:${gatewayPort}`;
const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || "";

if (!gatewayToken) {
  throw new Error("OPENCLAW_GATEWAY_TOKEN is required");
}

const toolTimeoutMs = 20000;
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
    String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    "--max-time",
    String(Math.max(1, Math.ceil((timeoutMs + 1000) / 1000))),
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
  const attempts = 3;
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
  notification: null,
};

console.log("Starting universal semantics proof");
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
if (inventoryParsed?.report_md) {
  await writeFile(join(proofDir, "inventory_report.md"), String(inventoryParsed.report_md));
}

const snapshot = inventoryParsed?.inventory_snapshot ?? {};
const semanticMap = inventoryParsed?.semantic_map?.by_entity ?? {};
const snapshotEntities = snapshot?.entities ?? {};

const getSnapshotState = (entityId) => {
  const entry = snapshotEntities[entityId];
  if (!entry) return null;
  return entry.state ?? null;
};

const isUnavailableState = (state) =>
  state === "unavailable" || state === "unknown";

const allowHighRisk = process.env.ALLOW_HIGH_RISK === "1" || process.env.AGGRESSIVE === "1";

const domainResults = {};
const semanticResults = {};
const needsConfirm = [];
const needsOverride = Array.isArray(inventoryParsed?.semantic_map?.needs_override)
  ? inventoryParsed.semantic_map.needs_override
  : [];

const pickEntityBySemantic = (semanticType, domainHint, predicate) => {
  for (const [entityId, resolution] of Object.entries(semanticMap)) {
    if (resolution?.semantic_type !== semanticType) continue;
    const entity = snapshot?.entities?.[entityId];
    if (!entity) continue;
    if (domainHint && entity.domain !== domainHint) continue;
    if (predicate && !predicate(entity)) continue;
    return entityId;
  }
  return null;
};

const safeCandidates = [
  {
    semantic: "light",
    domain: "light",
    intent: { action: "turn_on" },
    data: { brightness: "60%", color: "ljubicasto" },
    predicate: (entity) =>
      Array.isArray(entity?.attributes?.supported_color_modes) || entity?.attributes?.brightness !== undefined,
  },
  {
    semantic: "media_player",
    domain: "media_player",
    intent: { action: "set", property: "volume", value: "20%" },
    predicate: (entity) => entity?.attributes?.volume_level !== undefined,
  },
  { semantic: "input_boolean", domain: "input_boolean", intent: { action: "turn_on" } },
];

for (const candidate of safeCandidates) {
  const entityId = pickEntityBySemantic(candidate.semantic, candidate.domain, candidate.predicate);
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
    intent: candidate.intent,
    data: candidate.data ?? {},
  });
  results.actions[candidate.semantic] = action;
  const verificationOk = Boolean(action?.parsed?.verification?.ok);
  semanticResults[candidate.semantic] = {
    status: verificationOk ? "PASS" : "FAIL",
    reason: verificationOk ? "verified" : action?.parsed?.verification?.reason ?? "unverified",
  };
}

const riskySemantics = [
  { semantic: "switch", domain: "switch" },
  { semantic: "fan", domain: "fan" },
  { semantic: "cover", domain: "cover" },
  { semantic: "climate", domain: "climate" },
  { semantic: "lock", domain: "lock" },
  { semantic: "alarm", domain: "alarm_control_panel" },
  { semantic: "vacuum", domain: "vacuum" },
];
for (const candidate of riskySemantics) {
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
    intent: { action: "turn_on" },
    safe_probe: true,
  });
  results.actions[candidate.semantic] = action;
  const verificationOk = Boolean(action?.parsed?.verification?.ok);
  semanticResults[candidate.semantic] = {
    status: verificationOk ? "PASS_READONLY" : "FAIL",
    reason: verificationOk ? "verified_probe" : action?.parsed?.verification?.reason ?? "unverified",
  };
}

const notificationRes = await invokeTool("ha_call_service", {
  domain: "persistent_notification",
  service: "create",
  data: { title: "Luna Proof", message: `universal-semantics ${new Date().toISOString()}` },
});
results.notification = { raw: notificationRes, parsed: parseToolJsonResult(notificationRes) };

await writeJson("devtools_results.json", results);

const summary = {
  semantic_types: semanticResults,
  needs_override: needsOverride,
  needs_confirm: needsConfirm,
};

const statuses = Object.values(semanticResults).map((entry) => entry.status);
const overall = statuses.includes("FAIL") ? "FAIL" : "PASS";

await writeJson("RESULT.json", { overall, summary });

console.log("Proof script finished");
console.log(`OVERALL ${overall}`);
