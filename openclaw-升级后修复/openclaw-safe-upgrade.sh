#!/bin/zsh
set -euo pipefail

TARGET_VERSION="${1:-latest}"
REAPPLY_SCRIPT="$HOME/Desktop/openclaw-reapply-heartbeat-fix.sh"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm command not found in PATH" >&2
  exit 1
fi
if ! command -v openclaw >/dev/null 2>&1; then
  echo "openclaw command not found in PATH" >&2
  exit 1
fi
if [[ ! -x "$REAPPLY_SCRIPT" ]]; then
  echo "Reapply script not executable: $REAPPLY_SCRIPT" >&2
  exit 1
fi

echo "==> Upgrading OpenClaw to: $TARGET_VERSION"
if [[ "$TARGET_VERSION" == "latest" ]]; then
  npm install -g openclaw@latest
else
  npm install -g "openclaw@$TARGET_VERSION"
fi

echo "==> Version after official upgrade"
openclaw --version

INSTALLED_VERSION="$(openclaw --version | awk 'NR==1 {print $2}')"
echo "==> Reapplying heartbeat/session/toolMsg fixes on version: $INSTALLED_VERSION"
"$REAPPLY_SCRIPT" "$INSTALLED_VERSION"

echo "==> Verifying toolMsg.content.filter guard in installed pi-agent-core"
node - <<'NODE'
const { execSync } = require("child_process");
const fs = require("fs");
const root = execSync("npm root -g", { encoding: "utf8" }).trim();
const file = `${root}/openclaw/node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js`;
if (!fs.existsSync(file)) {
  console.error(`agent-loop.js not found: ${file}`);
  process.exit(2);
}
const text = fs.readFileSync(file, "utf8");
const unguarded =
  /\bmessage\.content\.filter\(\(c\)\s*=>\s*c\.type === "toolCall"\)/.test(text) ||
  /\bassistantMessage\.content\.filter\(\(c\)\s*=>\s*c\.type === "toolCall"\)/.test(text);
console.log(JSON.stringify({ file, guarded: !unguarded }, null, 2));
if (unguarded) process.exit(42);
NODE

echo "==> Verifying model failover resilience"
node - <<'NODE'
const fs = require("fs");
const p = process.env.HOME + "/.openclaw/openclaw.json";
const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
const model = cfg.agents?.defaults?.model || {};
const primary = typeof model.primary === "string" ? model.primary : "";
const fallbacks = Array.isArray(model.fallbacks) ? model.fallbacks.filter((x) => typeof x === "string" && x.trim()) : [];
const providers = new Set([primary, ...fallbacks].filter(Boolean).map((m) => String(m).split("/")[0]).filter(Boolean));
const healthy = Boolean(primary) && fallbacks.length >= 2 && providers.size >= 2;
console.log(JSON.stringify({ primary, fallbackCount: fallbacks.length, providerDiversity: providers.size, healthy }, null, 2));
if (!healthy) process.exit(42);
NODE

echo "==> Checking DNS health for Telegram/Feishu endpoints"
node - <<'NODE'
const dns = require("dns").promises;
const targets = ["api.telegram.org", "open.feishu.cn"];
(async () => {
  const out = [];
  for (const host of targets) {
    try {
      const res = await dns.lookup(host);
      out.push({ host, ok: true, address: res.address, family: res.family });
    } catch (e) {
      out.push({ host, ok: false, error: String(e && e.code ? e.code : e) });
    }
  }
  console.log(JSON.stringify({ dnsChecks: out }, null, 2));
})();
NODE

echo "==> Log hotspot summary (last 5 days)"
node - <<'NODE'
const fs = require("fs");
const home = process.env.HOME;
const paths = [home + "/.openclaw/logs/gateway.log", home + "/.openclaw/logs/gateway.err.log"];
const since = Date.now() - 5 * 24 * 60 * 60 * 1000;
const defs = [
  { key: "all_models_failed", severity: 100, regex: /All models failed|complete failover exhaustion/i },
  { key: "llm_network_error", severity: 70, regex: /LLM request failed: network connection error|Connection error|fetch failed|UND_ERR_CONNECT_TIMEOUT|ECONNRESET|ECONNREFUSED/i },
  { key: "typeerror_content_filter", severity: 80, regex: /content\.filter is not a function|toolMsg\.content\.filter|msg\.content\.filter/i },
  { key: "webchat_duplicate_retry", severity: 75, regex: /duplicate reflection requests|reflection requests sent repeatedly|openclaw-control-ui.*duplicate/i },
  { key: "webchat_reconnect_storm", severity: 55, regex: /\[ws\]\s+webchat\s+(connected|disconnected)/i },
  { key: "skill_path_outside_root", severity: 65, regex: /Skipping skill path that resolves outside its configured root/i },
  { key: "timeout", severity: 45, regex: /timed out|timeout/i },
  { key: "telegram_polling_conflict", severity: 50, regex: /polling runner stopped|polling stall detected|deleteWebhook failed|getUpdates|409 Conflict|webhook/i },
];
const counts = Object.fromEntries(defs.map((d) => [d.key, 0]));
for (const p of paths) {
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2})/);
    if (!m) continue;
    const ts = new Date(m[1]).getTime();
    if (!Number.isFinite(ts) || ts < since) continue;
    for (const d of defs) if (d.regex.test(line)) counts[d.key] += 1;
  }
}
const ranked = defs.map((d) => ({ key: d.key, count: counts[d.key], score: counts[d.key] * d.severity })).sort((a, b) => b.score - a.score);
console.log(JSON.stringify({ windowDays: 5, ranked }, null, 2));
NODE

echo "==> Webchat duplicate-display diagnostics (last 24 hours)"
node - <<'NODE'
const fs = require("fs");
const home = process.env.HOME;
const logPaths = [home + "/.openclaw/logs/gateway.log", home + "/.openclaw/logs/gateway.err.log"];
const since = Date.now() - 24 * 60 * 60 * 1000;
let wsConnect = 0;
let wsDisconnect = 0;
for (const p of logPaths) {
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2})/);
    if (!m) continue;
    const ts = new Date(m[1]).getTime();
    if (!Number.isFinite(ts) || ts < since) continue;
    if (/\[ws\]\s+webchat connected/i.test(line)) wsConnect += 1;
    if (/\[ws\]\s+webchat disconnected/i.test(line)) wsDisconnect += 1;
  }
}

const sessionsPath = home + "/.openclaw/agents/main/sessions/sessions.json";
let transcriptPath = null;
try {
  const store = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
  const main = store["agent:main:main"];
  if (main?.sessionId) {
    transcriptPath = `${home}/.openclaw/agents/main/sessions/${main.sessionId}.jsonl`;
  }
} catch {}
let userMessages = 0;
let duplicateBuckets = 0;
if (transcriptPath && fs.existsSync(transcriptPath)) {
  const seen = new Map();
  for (const line of fs.readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const msg = obj?.message;
    if (!msg || msg.role !== "user") continue;
    const ts = typeof msg.timestamp === "number" ? msg.timestamp : 0;
    if (!ts || ts < since) continue;
    const text = typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n").trim()
        : typeof msg.text === "string"
          ? msg.text
          : "";
    if (!text) continue;
    userMessages += 1;
    const key = `${text}::${msg.idempotencyKey || ""}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  duplicateBuckets = [...seen.values()].filter((n) => n > 1).length;
}

console.log(
  JSON.stringify(
    {
      windowHours: 24,
      webchatWsConnect: wsConnect,
      webchatWsDisconnect: wsDisconnect,
      userMessages,
      duplicateMessageBuckets: duplicateBuckets,
      note:
        duplicateBuckets > 0
          ? "possible duplicate send/display detected; inspect control-ui retry/idempotency behavior"
          : "no transcript-level duplicate bucket detected in current main session",
    },
    null,
    2,
  ),
);
NODE

echo "==> Final verification"
openclaw --version
openclaw gateway health

echo "==> Safe upgrade finished"
