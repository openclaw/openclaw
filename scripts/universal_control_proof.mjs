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

const log = (...args) => {
  console.log(...args);
};

const toNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^0-9.+-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const writeJson = async (name, data) => {
  await writeFile(join(proofDir, name), JSON.stringify(data, null, 2));
};

const runService = async (name, request) => {
  const res = await invokeTool("ha_call_service", request);
  const parsed = parseToolJsonResult(res);
  return { name, request, raw: res, parsed };
};

const pickFromDomain = (entities, predicate) => {
  if (!Array.isArray(entities) || entities.length === 0) return null;
  for (const entry of entities) {
    if (predicate(entry)) return entry;
  }
  return entities[0];
};

const results = {
  ping: null,
  inventory: null,
  selected_entities: {},
  actions: {},
  notification: null,
  forced_confirm: null,
};

log("Starting universal understanding proof");
log(`Gateway URL: ${gatewayUrl}`);

const pingRes = await invokeTool("ha_ping", {});
results.ping = { raw: pingRes, parsed: parseToolJsonResult(pingRes) };
await writeJson("ha_ping.json", results.ping);
log("ha_ping ok:", Boolean(pingRes.ok));
if (!pingRes.ok) {
  throw new Error("ha_ping failed");
}

const inventoryRes = await invokeTool("ha_inventory_snapshot", {});
const inventoryParsed = parseToolJsonResult(inventoryRes);
results.inventory = { raw: inventoryRes, parsed: inventoryParsed };
await writeJson("inventory_snapshot.json", inventoryParsed ?? {});

const inventoryEntities = inventoryParsed?.entities ?? {};
const entitiesByDomain = {};
for (const entity of Object.values(inventoryEntities)) {
  const domain = entity?.domain;
  if (!domain) continue;
  if (!entitiesByDomain[domain]) entitiesByDomain[domain] = [];
  entitiesByDomain[domain].push(entity);
}

const selected = {
  light: pickFromDomain(entitiesByDomain.light, (entry) => {
    const modes = Array.isArray(entry?.attributes?.supported_color_modes)
      ? entry.attributes.supported_color_modes
      : [];
    return modes.some((mode) => ["hs", "xy", "rgb", "color_temp"].includes(mode));
  }),
  switch: pickFromDomain(entitiesByDomain.switch, () => true),
  media_player: pickFromDomain(entitiesByDomain.media_player, (entry) => entry?.attributes?.volume_level !== undefined),
  climate: pickFromDomain(entitiesByDomain.climate, () => true),
  fan: pickFromDomain(entitiesByDomain.fan, () => true),
  cover: pickFromDomain(entitiesByDomain.cover, () => true),
};

results.selected_entities = selected;
await writeJson("devtools_selected_entities.json", selected);

const domainResults = {};

if (selected.light) {
  const action = {
    domain: "light",
    service: "turn_on",
    target: { entity_id: [selected.light.entity_id] },
    data: { brightness: "60%", color: "ljubičasto" },
  };
  domainResults.light = await runService("light", action);
}

if (selected.switch) {
  const current = selected.switch.state;
  const service = current === "on" ? "turn_off" : "turn_on";
  const action = {
    domain: "switch",
    service,
    target: { entity_id: [selected.switch.entity_id] },
    data: {},
  };
  domainResults.switch = await runService("switch", action);
}

if (selected.media_player) {
  const action = {
    domain: "media_player",
    service: "volume_set",
    target: { entity_id: [selected.media_player.entity_id] },
    data: { volume: "20%" },
  };
  domainResults.media_player = await runService("media_player", action);
}

if (selected.climate) {
  const attrs = selected.climate.attributes || {};
  const currentTemp = toNumber(attrs.temperature ?? attrs.current_temperature);
  const minTemp = toNumber(attrs.min_temp);
  const maxTemp = toNumber(attrs.max_temp);
  let desired = currentTemp !== null ? currentTemp + 1 : 22;
  if (minTemp !== null && maxTemp !== null) {
    desired = clamp(desired, minTemp, maxTemp);
  }
  const action = {
    domain: "climate",
    service: "set_temperature",
    target: { entity_id: [selected.climate.entity_id] },
    data: { temperature: desired },
  };
  domainResults.climate = await runService("climate", action);
}

if (selected.fan) {
  const attrs = selected.fan.attributes || {};
  const presetModes = Array.isArray(attrs.preset_modes) ? attrs.preset_modes : [];
  const currentPreset = typeof attrs.preset_mode === "string" ? attrs.preset_mode : "";
  const currentPercentage = toNumber(attrs.percentage);
  const step = toNumber(attrs.percentage_step) || 10;
  let action = null;

  if (presetModes.length > 0) {
    const nextPreset = presetModes.find((mode) => mode !== currentPreset) || presetModes[0];
    action = {
      domain: "fan",
      service: "set_preset_mode",
      target: { entity_id: [selected.fan.entity_id] },
      data: { preset_mode: nextPreset },
    };
  } else if (currentPercentage !== null) {
    let desired = currentPercentage + step;
    if (desired > 100) desired = currentPercentage - step;
    if (desired < 0) desired = 50;
    action = {
      domain: "fan",
      service: "set_percentage",
      target: { entity_id: [selected.fan.entity_id] },
      data: { percentage: `${desired}%` },
    };
  } else {
    const currentState = selected.fan.state;
    const service = currentState === "on" ? "turn_off" : "turn_on";
    action = {
      domain: "fan",
      service,
      target: { entity_id: [selected.fan.entity_id] },
      data: {},
    };
  }

  if (action) {
    const primary = await runService("fan", action);
    let fallback = null;
    if (!primary?.parsed?.verification?.ok) {
      const currentState = selected.fan.state;
      const service = currentState === "on" ? "turn_off" : "turn_on";
      const fallbackAction = {
        domain: "fan",
        service,
        target: { entity_id: [selected.fan.entity_id] },
        data: {},
      };
      fallback = await runService("fan_fallback", fallbackAction);
    }
    domainResults.fan = { primary, fallback };
  }
}

if (selected.cover) {
  const action = {
    domain: "cover",
    service: "set_cover_position",
    target: { entity_id: [selected.cover.entity_id] },
    data: { position: "30%" },
  };
  domainResults.cover = await runService("cover", action);
}

results.actions = domainResults;

const notificationId = `tool_notify_${Date.now()}`;
const notificationCall = {
  domain: "persistent_notification",
  service: "create",
  data: {
    title: "Luna Tool Proof",
    message: `tool-proof ${new Date().toISOString()}`,
    notification_id: notificationId,
  },
};

const notificationRes = await runService("notification", notificationCall);
results.notification = notificationRes;

const forcedNotificationId = `tool_confirm_${Date.now()}`;
const forcedCall = {
  domain: "persistent_notification",
  service: "create",
  data: {
    title: "Luna Tool Confirm",
    message: `tool-confirm ${new Date().toISOString()}`,
    notification_id: forcedNotificationId,
  },
  force_confirm: true,
};

const forceRes = await invokeTool("ha_call_service", forcedCall);
const forceParsed = parseToolJsonResult(forceRes);

let prepareRes = null;
let prepareParsed = null;
let confirmRes = null;
let confirmParsed = null;

if (forceParsed && forceParsed.error === "confirm_required") {
  prepareRes = await invokeTool("ha_prepare_risky_action", {
    kind: "ha_call_service",
    action: {
      domain: "persistent_notification",
      service: "create",
      data: forcedCall.data,
    },
    reason: "forced_confirm_test",
  });
  prepareParsed = parseToolJsonResult(prepareRes);
  const token = prepareParsed?.token;
  if (token) {
    confirmRes = await invokeTool("ha_confirm_action", { token });
    confirmParsed = parseToolJsonResult(confirmRes);
  }
}

results.forced_confirm = {
  force_call: { request: forcedCall, raw: forceRes, parsed: forceParsed },
  prepare: { raw: prepareRes, parsed: prepareParsed },
  confirm: { raw: confirmRes, parsed: confirmParsed },
};

await writeJson("devtools_results.json", results);

const summary = {};
const domainNames = ["light", "switch", "media_player", "climate", "fan", "cover"];
for (const domain of domainNames) {
  const entry = domainResults[domain];
  if (!entry) {
    summary[domain] = { status: "SKIP", reason: "no_entities" };
    continue;
  }
  const primary = entry?.primary ?? entry;
  const fallback = entry?.fallback ?? null;
  const verification = (fallback?.parsed?.verification?.ok
    ? fallback?.parsed?.verification
    : primary?.parsed?.verification) ?? null;
  if (verification?.ok) {
    summary[domain] = {
      status: "PASS",
      reason: fallback?.parsed?.verification?.ok ? "verified_with_fallback" : "verified",
      verification,
    };
  } else {
    summary[domain] = {
      status: "FAIL",
      reason: verification?.reason ?? "unverified",
      verification,
    };
  }
}

const notificationVerification = notificationRes?.parsed?.verification ?? null;
const notificationStatus = notificationVerification?.ok ? "PASS" : "FAIL";
summary.notification = {
  status: notificationStatus,
  reason: notificationVerification?.reason ?? "unverified",
  verification: notificationVerification,
};

const forcedConfirmOk = Boolean(results.forced_confirm?.confirm?.parsed?.verification?.ok);
summary.forced_confirm = {
  status: forcedConfirmOk ? "PASS" : "FAIL",
  reason: forcedConfirmOk ? "verified" : "unverified",
  verification: results.forced_confirm?.confirm?.parsed?.verification ?? null,
};

const overall = Object.values(summary).every((entry) => entry.status === "PASS" || entry.status === "SKIP")
  ? "PASS"
  : "FAIL";

await writeJson("RESULT.json", { overall, summary });

log("Proof script finished");
log("Results written to:", join(proofDir, "devtools_results.json"));
log(`OVERALL ${overall}`);
