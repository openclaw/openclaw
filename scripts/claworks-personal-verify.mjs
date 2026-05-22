#!/usr/bin/env node
/**
 * Personal-work profile verification (config repair + live gateway probes).
 *
 *   set -a && source ~/.claworks/personal.env && set +a
 *   pnpm claworks:personal:verify
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CLAWORKS_PRODUCT: "1", ...opts.env },
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

function resolveConfig() {
  const configPath =
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    join(process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".claworks"), "claworks.json");
  if (!existsSync(configPath)) {
    console.error(`[personal-verify] missing config: ${configPath}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(configPath, "utf8"));
}

console.log("[personal-verify] repair personal_work profile …");
run(process.execPath, [join(root, "scripts/claworks-repair-personal.mjs")]);

if (process.env.CLAWORKS_SKIP_RUNTIME_BUILD !== "1") {
  console.log("[personal-verify] build @claworks/runtime dist …");
  run("pnpm", ["claworks:runtime:build"], { env: { CLAWORKS_SKIP_RUNTIME_BUILD: "1" } });
}

const config = resolveConfig();
const port = config.gateway?.port ?? Number(process.env.CLAWORKS_GATEWAY_PORT ?? 18800);
const token = config.gateway?.auth?.token?.trim();
const base = `http://127.0.0.1:${port}`;

async function jfetch(path, init = {}) {
  const headers = { "content-type": "application/json", ...(init.headers ?? {}) };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

console.log(`[personal-verify] probing ${base} …`);
const health = await jfetch("/v1/health");
console.log("[personal-verify] health:", health.status, "kb_provider=", health.kb_provider);

const kb = await jfetch("/v1/kb/status");
console.log("[personal-verify] kb:", kb);

const playbooks = await jfetch("/v1/playbooks");
const ids = (playbooks.playbooks ?? []).map((p) => p.id);
if (!ids.includes("kb_folder_sync_on_event")) {
  console.warn(
    "[personal-verify] playbook kb_folder_sync_on_event not loaded — check personal-enterprise pack symlink",
  );
  process.exitCode = 1;
} else {
  console.log("[personal-verify] playbook kb_folder_sync_on_event loaded");
}

const allow = config.plugins?.allow ?? [];
if (allow.includes("qwen")) {
  console.warn("[personal-verify] plugins.allow still contains qwen (Ali channel plugin)");
  process.exitCode = 1;
}
if (allow.includes("web-fetch")) {
  console.warn("[personal-verify] plugins.allow contains stale web-fetch");
  process.exitCode = 1;
}

const connectors = config.plugins?.entries?.["claworks-robot"]?.config?.connectors ?? {};
if (!connectors["filesystem-kb"]?.enabled) {
  console.warn("[personal-verify] filesystem-kb connector not enabled");
  process.exitCode = 1;
} else {
  console.log("[personal-verify] filesystem-kb connector enabled");
}

console.log("[personal-verify] running kb-smoke …");
const smoke = spawnSync(process.execPath, [join(root, "scripts/claworks-kb-smoke.mjs")], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    CLAWORKS_BASE_URL: base,
    CLAWORKS_API_KEY: token ?? "",
  },
});
if (smoke.status !== 0) {
  console.warn(
    "[personal-verify] kb-smoke reported issues (ingest/flush may still be OK; fix embedding API for search)",
  );
}

console.log("[personal-verify] done");
