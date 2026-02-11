#!/usr/bin/env bash
set -euo pipefail

STORE_PATH="${STORE_PATH:-$HOME/.openclaw/agents/main/sessions/sessions.json}"
KEEP_RECENT="${KEEP_RECENT:-2}"
STALE_DAYS="${STALE_DAYS:-7}"
HIGH_USAGE_PCT="${HIGH_USAGE_PCT:-95}"
HIGH_USAGE_MIN_AGE_HOURS="${HIGH_USAGE_MIN_AGE_HOURS:-24}"
RESTART_GATEWAY="${RESTART_GATEWAY:-1}"
DRY_RUN="${DRY_RUN:-0}"

if [[ ! -f "$STORE_PATH" ]]; then
  echo "[cleanup] session store not found: $STORE_PATH"
  exit 0
fi

BACKUP_PATH="$STORE_PATH.bak.$(date +%Y%m%d-%H%M%S)"
cp "$STORE_PATH" "$BACKUP_PATH"
echo "[cleanup] backup created: $BACKUP_PATH"

node - "$STORE_PATH" "$KEEP_RECENT" "$STALE_DAYS" "$HIGH_USAGE_PCT" "$HIGH_USAGE_MIN_AGE_HOURS" "$DRY_RUN" <<'EOF'
const fs = require("fs");

const [
  storePath,
  keepRecentRaw,
  staleDaysRaw,
  highUsagePctRaw,
  highUsageMinAgeHoursRaw,
  dryRunRaw,
] = process.argv.slice(2);

const keepRecent = Number(keepRecentRaw);
const staleDays = Number(staleDaysRaw);
const highUsagePct = Number(highUsagePctRaw);
const highUsageMinAgeHours = Number(highUsageMinAgeHoursRaw);
const dryRun = dryRunRaw === "1";

const now = Date.now();
const staleMs = staleDays * 24 * 60 * 60 * 1000;
const highUsageMinAgeMs = highUsageMinAgeHours * 60 * 60 * 1000;

const raw = fs.readFileSync(storePath, "utf8");
const store = JSON.parse(raw);
const keys = Object.keys(store);

const rows = keys.map((key) => {
  const entry = store[key] || {};
  const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
  const totalTokens = typeof entry.totalTokens === "number" ? entry.totalTokens : 0;
  const contextTokens = typeof entry.contextTokens === "number" ? entry.contextTokens : 0;
  const usagePct = contextTokens > 0 ? (totalTokens / contextTokens) * 100 : 0;
  const ageMs = Math.max(0, now - updatedAt);
  return { key, updatedAt, usagePct, ageMs };
});

rows.sort((a, b) => b.updatedAt - a.updatedAt);
const keepSet = new Set(rows.slice(0, Math.max(0, keepRecent)).map((r) => r.key));

const deleted = [];
for (const row of rows) {
  if (keepSet.has(row.key)) {
    continue;
  }
  const stale = row.ageMs >= staleMs;
  const highUsageOld = row.usagePct >= highUsagePct && row.ageMs >= highUsageMinAgeMs;
  if (stale || highUsageOld) {
    deleted.push(row.key);
    if (!dryRun) {
      delete store[row.key];
    }
  }
}

if (!dryRun && deleted.length > 0) {
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
}

const reason =
  deleted.length === 0
    ? "none"
    : `deleted=${deleted.length} keep_recent=${keepRecent} stale_days=${staleDays} high_usage_pct=${highUsagePct}`;

console.log(`[cleanup] sessions_total=${rows.length} ${reason}`);
if (deleted.length > 0) {
  for (const key of deleted) {
    console.log(`[cleanup] removed ${key}`);
  }
}
EOF

if [[ "$RESTART_GATEWAY" == "1" ]]; then
  openclaw gateway restart >/dev/null 2>&1 || true
  echo "[cleanup] gateway restart requested"
fi

openclaw sessions || true
