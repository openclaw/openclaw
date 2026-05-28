#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const REQUIRED_GUARDS = ["BLOCKED_BY_ACTIVE_TASK", "unrelated dirty changes", "只在準備修改的檔案"];

const repoRoot = process.cwd();
const desiredPath = path.join(
  repoRoot,
  ".openclaw",
  "automation",
  "desired-heartbeat-automation.json",
);
const reportPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-automation-sync-latest.json",
);

function nowMs() {
  return Date.now();
}

function ensureGuard(prompt) {
  let next = String(prompt ?? "");
  for (const guard of REQUIRED_GUARDS) {
    if (!next.includes(guard)) {
      next = `${next} ${guard}`.trim();
    }
  }
  return next;
}

function toTomlValue(value) {
  if (typeof value === "number") {
    return String(Math.floor(value));
  }
  const escaped = String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function parseTomlLoose(text) {
  const out = {};
  for (const rawLine of String(text ?? "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/u.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1];
    const valueRaw = match[2].trim();
    if (valueRaw.startsWith('"') && valueRaw.endsWith('"')) {
      out[key] = valueRaw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else if (/^\d+$/u.test(valueRaw)) {
      out[key] = Number(valueRaw);
    } else {
      out[key] = valueRaw;
    }
  }
  return out;
}

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
}

async function readTomlIfExists(filePath) {
  try {
    return parseTomlLoose(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeUtf8(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

function buildToml(record) {
  const keys = [
    "version",
    "id",
    "kind",
    "name",
    "prompt",
    "status",
    "rrule",
    "target_thread_id",
    "created_at",
    "updated_at",
  ];
  return `${keys.map((k) => `${k} = ${toTomlValue(record[k])}`).join("\n")}\n`;
}

async function main() {
  const desired = await readJson(desiredPath);
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const id = String(desired.id || "automation");
  const tomlPath = path.join(codexHome, "automations", id, "automation.toml");
  const existing = await readTomlIfExists(tomlPath);

  const createdAt = Number(existing?.created_at || desired.created_at || nowMs());
  const updatedAt = nowMs();
  const prompt = ensureGuard(desired.prompt);

  const next = {
    version: Number(desired.version || 1),
    id,
    kind: String(desired.kind || "heartbeat"),
    name: String(desired.name || id),
    prompt,
    status: String(desired.status || "ACTIVE"),
    rrule: String(desired.rrule || "RRULE:FREQ=MINUTELY;INTERVAL=2"),
    target_thread_id: String(desired.target_thread_id || existing?.target_thread_id || ""),
    created_at: createdAt,
    updated_at: updatedAt,
  };

  await writeUtf8(tomlPath, buildToml(next));

  const report = {
    schema: "openclaw.automation.sync-from-openclaw.v1",
    generatedAt: new Date().toISOString(),
    repoRoot,
    desiredPath,
    codexHome,
    tomlPath,
    synced: true,
    id: next.id,
    status: next.status,
    hasRequiredGuard: REQUIRED_GUARDS.every((g) => next.prompt.includes(g)),
    targetThreadId: next.target_thread_id,
  };
  await writeUtf8(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write(
    [
      "OPENCLAW_AUTOMATION_SYNC=OK",
      `id=${next.id}`,
      `status=${next.status}`,
      `target=${next.target_thread_id || "missing"}`,
      `guard=${report.hasRequiredGuard ? "ok" : "missing"}`,
    ].join("\n") + "\n",
  );
}

await main();
