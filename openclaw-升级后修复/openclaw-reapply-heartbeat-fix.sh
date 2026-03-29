#!/bin/zsh

set -euo pipefail

DEFAULT_FIX_REPO="$HOME/Documents/New project/openclaw-src-2026.3.13-fix2.backup-20260329"
FIX_REPO="${OPENCLAW_FIX_REPO:-$DEFAULT_FIX_REPO}"
FIX_COMMIT="${OPENCLAW_HEARTBEAT_FIX_COMMIT:-7a650c4f8f}"
WORKTREE_ROOT="${OPENCLAW_FIX_WORKTREES:-$HOME/Documents/New project/openclaw-fixed-worktrees}"
FETCH_ATTEMPTS="${OPENCLAW_FIX_FETCH_ATTEMPTS:-3}"
FETCH_LOW_SPEED_LIMIT="${OPENCLAW_FIX_FETCH_LOW_SPEED_LIMIT:-1024}"
FETCH_LOW_SPEED_TIME="${OPENCLAW_FIX_FETCH_LOW_SPEED_TIME:-20}"

if ! command -v openclaw >/dev/null 2>&1; then
  echo "openclaw command not found in PATH" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm command not found in PATH" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm command not found in PATH" >&2
  exit 1
fi

if [[ ! -d "$FIX_REPO/.git" ]]; then
  AUTO_REPO="$(ls -1dt "$HOME/Documents/New project"/openclaw-src-* 2>/dev/null | head -n 1 || true)"
  if [[ -n "${AUTO_REPO:-}" && -d "$AUTO_REPO/.git" ]]; then
    FIX_REPO="$AUTO_REPO"
    echo "warn: configured fix repo missing; auto-selected latest source repo: $FIX_REPO" >&2
  fi
fi

if [[ ! -d "$FIX_REPO/.git" ]]; then
  echo "Fix source repo not found: $FIX_REPO" >&2
  echo "Hint: set OPENCLAW_FIX_REPO to a valid openclaw source repo path." >&2
  exit 1
fi

fetch_tags() {
  local attempt=1
  while (( attempt <= FETCH_ATTEMPTS )); do
    if GIT_TERMINAL_PROMPT=0 \
      GIT_HTTP_LOW_SPEED_LIMIT="$FETCH_LOW_SPEED_LIMIT" \
      GIT_HTTP_LOW_SPEED_TIME="$FETCH_LOW_SPEED_TIME" \
      git -C "$FIX_REPO" fetch origin --tags --prune --force; then
      return 0
    fi
    echo "warn: fetch tags attempt ${attempt}/${FETCH_ATTEMPTS} failed, retrying..." >&2
    sleep 2
    attempt=$((attempt + 1))
  done
  return 1
}

resolve_tag() {
  local tag="$1"
  if git -C "$FIX_REPO" rev-parse --verify "${tag}^{commit}" >/dev/null 2>&1; then
    echo "$tag"
    return 0
  fi
  if git -C "$FIX_REPO" rev-parse --verify "${tag}-1^{commit}" >/dev/null 2>&1; then
    echo "${tag}-1"
    return 0
  fi
  echo ""
  return 1
}

cleanup_worktree_locks() {
  local worktree_name="$1"
  local worktree_git="$FIX_REPO/.git/worktrees/$worktree_name"
  rm -f "$FIX_REPO/.git/packed-refs.lock" 2>/dev/null || true
  if [[ -d "$worktree_git" ]]; then
    rm -f "$worktree_git/index.lock" \
      "$worktree_git/AUTO_MERGE.lock" \
      "$worktree_git/locked" 2>/dev/null || true
  fi
}

check_main_session_pollution() {
  node - <<'NODE'
const fs = require("fs");
const p = process.env.HOME + "/.openclaw/agents/main/sessions/sessions.json";
const data = JSON.parse(fs.readFileSync(p, "utf8"));
const e = data["agent:main:main"] || {};
const polluted =
  e.lastTo === "heartbeat" ||
  e.deliveryContext?.to === "heartbeat" ||
  e.origin?.provider === "heartbeat";
console.log(
  JSON.stringify(
    {
      polluted,
      lastTo: e.lastTo,
      deliveryContext: e.deliveryContext,
      origin: e.origin,
    },
    null,
    2,
  ),
);
if (polluted) process.exit(42);
NODE
}

sanitize_main_session_store() {
  local backup_dir
  backup_dir="$HOME/.openclaw/agents/main/sessions/repair-backups/$(date -u +%Y-%m-%dT%H-%M-%SZ)-reapply-postcheck"
  mkdir -p "$backup_dir"
  cp "$HOME/.openclaw/agents/main/sessions/sessions.json" "$backup_dir/sessions.json.backup"
  node - <<'NODE'
const fs = require("fs");
const p = process.env.HOME + "/.openclaw/agents/main/sessions/sessions.json";
const data = JSON.parse(fs.readFileSync(p, "utf8"));
const entry = data["agent:main:main"];
if (!entry) process.exit(0);
if (entry.lastTo === "heartbeat") delete entry.lastTo;
if (entry.deliveryContext?.to === "heartbeat") delete entry.deliveryContext.to;
if (entry.deliveryContext && Object.keys(entry.deliveryContext).length === 0) delete entry.deliveryContext;
if (entry.origin?.provider === "heartbeat") entry.origin.provider = "webchat";
if (entry.origin?.label === "heartbeat") delete entry.origin.label;
if (entry.origin?.from === "heartbeat") delete entry.origin.from;
if (entry.origin?.to === "heartbeat") delete entry.origin.to;
if (entry.origin && Object.keys(entry.origin).length === 0) delete entry.origin;
fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
NODE
  echo "warn: main session store was polluted; backup saved at: $backup_dir" >&2
}

get_installed_agent_loop_path() {
  local npm_root
  npm_root="$(npm root -g 2>/dev/null | tr -d '\r')"
  echo "$npm_root/openclaw/node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js"
}

check_toolmsg_filter_guard_installed() {
  local agent_loop
  agent_loop="$(get_installed_agent_loop_path)"
  if [[ ! -f "$agent_loop" ]]; then
    echo "warn: pi-agent-core agent-loop.js not found at: $agent_loop" >&2
    return 2
  fi
  AGENT_LOOP_PATH="$agent_loop" node - <<'NODE'
const fs = require("fs");
const p = process.env.AGENT_LOOP_PATH;
const text = fs.readFileSync(p, "utf8");
const hits = {
  message: /\bmessage\.content\.filter\(\(c\)\s*=>\s*c\.type === "toolCall"\)/.test(text),
  assistantMessage: /\bassistantMessage\.content\.filter\(\(c\)\s*=>\s*c\.type === "toolCall"\)/.test(text),
};
const guarded = !hits.message && !hits.assistantMessage;
console.log(JSON.stringify({ guarded, hits, file: p }, null, 2));
if (!guarded) process.exit(42);
NODE
}

apply_toolmsg_filter_hotfix_installed() {
  local agent_loop
  local backup_dir
  agent_loop="$(get_installed_agent_loop_path)"
  if [[ ! -f "$agent_loop" ]]; then
    echo "warn: cannot hotfix missing file: $agent_loop" >&2
    return 1
  fi
  backup_dir="$HOME/.openclaw/agents/main/sessions/repair-backups/$(date -u +%Y-%m-%dT%H-%M-%SZ)-toolmsg-filter-hotfix"
  mkdir -p "$backup_dir"
  cp "$agent_loop" "$backup_dir/agent-loop.js.backup"
  AGENT_LOOP_PATH="$agent_loop" node - <<'NODE'
const fs = require("fs");
const p = process.env.AGENT_LOOP_PATH;
let text = fs.readFileSync(p, "utf8");
let replacedMessage = 0;
let replacedAssistant = 0;
text = text.replace(
  /\bmessage\.content\.filter\(\(c\)\s*=>\s*c\.type === "toolCall"\)/g,
  () => {
    replacedMessage++;
    return '(Array.isArray(message.content) ? message.content : []).filter((c) => c.type === "toolCall")';
  },
);
text = text.replace(
  /\bassistantMessage\.content\.filter\(\(c\)\s*=>\s*c\.type === "toolCall"\)/g,
  () => {
    replacedAssistant++;
    return '(Array.isArray(assistantMessage.content) ? assistantMessage.content : []).filter((c) => c.type === "toolCall")';
  },
);
fs.writeFileSync(p, text);
console.log(JSON.stringify({ file: p, replacedMessage, replacedAssistant }, null, 2));
NODE
  echo "warn: toolMsg.content.filter hotfix backup saved at: $backup_dir" >&2
}

clear_telegram_webhooks_from_config() {
  node - <<'NODE'
const fs = require("fs");
const { execFileSync } = require("child_process");
const cfgPath = process.env.HOME + "/.openclaw/openclaw.json";
if (!fs.existsSync(cfgPath)) process.exit(0);
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const telegram = cfg.channels?.telegram;
if (!telegram || typeof telegram !== "object") {
  console.log("telegram webhook cleanup: skipped (telegram channel not configured)");
  process.exit(0);
}
const tokens = new Set();
if (typeof telegram.botToken === "string" && telegram.botToken.trim()) tokens.add(telegram.botToken.trim());
if (telegram.accounts && typeof telegram.accounts === "object") {
  for (const account of Object.values(telegram.accounts)) {
    if (account && typeof account === "object" && typeof account.botToken === "string" && account.botToken.trim()) {
      tokens.add(account.botToken.trim());
    }
  }
}
let cleaned = 0;
let failed = 0;
for (const token of tokens) {
  const url = `https://api.telegram.org/bot${token}/deleteWebhook`;
  try {
    const out = execFileSync(
      "curl",
      ["-sS", "-X", "POST", url, "-d", "drop_pending_updates=true", "--max-time", "20"],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(out);
    if (parsed?.ok) {
      cleaned += 1;
    } else {
      failed += 1;
    }
  } catch {
    failed += 1;
  }
}
console.log(JSON.stringify({ action: "telegram_delete_webhook", tokens: tokens.size, cleaned, failed }, null, 2));
if (failed > 0) process.exit(42);
NODE
}

check_model_failover_resilience() {
  node - <<'NODE'
const fs = require("fs");
const p = process.env.HOME + "/.openclaw/openclaw.json";
const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
const model = cfg.agents?.defaults?.model || {};
const primary = typeof model.primary === "string" ? model.primary : "";
const fallbacks = Array.isArray(model.fallbacks) ? model.fallbacks.filter((x) => typeof x === "string" && x.trim()) : [];
const all = [primary, ...fallbacks].filter(Boolean);
const providers = new Set(all.map((m) => String(m).split("/")[0]).filter(Boolean));
const healthy = Boolean(primary) && fallbacks.length >= 2 && providers.size >= 2;
console.log(
  JSON.stringify(
    {
      primary,
      fallbackCount: fallbacks.length,
      providerDiversity: providers.size,
      healthy,
      note: healthy
        ? "model failover baseline OK"
        : "recommend >=1 primary + >=2 fallbacks + >=2 providers to reduce all-model-failed risk",
    },
    null,
    2,
  ),
);
if (!healthy) process.exit(42);
NODE
}

summarize_gateway_error_hotspots() {
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
  { key: "dns_enotfound", severity: 40, regex: /ENOTFOUND|getaddrinfo/i },
  { key: "rate_limit_429", severity: 35, regex: /429|Too Many Requests|rate limit|Resource has been exhausted/i },
  { key: "graph_memory_extract_failed", severity: 30, regex: /graph-memory.*extract failed|graph-memory.*fetch failed/i },
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
const ranked = defs
  .map((d) => ({ key: d.key, count: counts[d.key], severity: d.severity, score: counts[d.key] * d.severity }))
  .sort((a, b) => b.score - a.score);
console.log(JSON.stringify({ windowDays: 5, ranked }, null, 2));
NODE
}

ensure_channel_retry_policy_baseline() {
  node - <<'NODE'
const fs = require("fs");
const p = process.env.HOME + "/.openclaw/openclaw.json";
const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
let changed = false;
const channels = cfg.channels || {};
if (channels.telegram && typeof channels.telegram === "object") {
  if (!channels.telegram.retry || typeof channels.telegram.retry !== "object") {
    channels.telegram.retry = { attempts: 3, minDelayMs: 400, maxDelayMs: 30000, jitter: 0.1 };
    changed = true;
  } else {
    for (const [k, v] of Object.entries({ attempts: 3, minDelayMs: 400, maxDelayMs: 30000, jitter: 0.1 })) {
      if (channels.telegram.retry[k] === undefined) {
        channels.telegram.retry[k] = v;
        changed = true;
      }
    }
  }
}
if (channels.discord && typeof channels.discord === "object") {
  if (!channels.discord.retry || typeof channels.discord.retry !== "object") {
    channels.discord.retry = { attempts: 3, minDelayMs: 500, maxDelayMs: 30000, jitter: 0.1 };
    changed = true;
  } else {
    for (const [k, v] of Object.entries({ attempts: 3, minDelayMs: 500, maxDelayMs: 30000, jitter: 0.1 })) {
      if (channels.discord.retry[k] === undefined) {
        channels.discord.retry[k] = v;
        changed = true;
      }
    }
  }
}
cfg.channels = channels;
if (changed) fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
console.log(JSON.stringify({ changed, telegramRetry: channels.telegram?.retry, discordRetry: channels.discord?.retry }, null, 2));
NODE
}

check_webchat_retry_idempotency_patch_source() {
  local ok=0
  if rg -q "hasOptimisticEcho" "$WORKTREE_DIR/ui/src/ui/controllers/chat.ts" \
    && rg -q "runId: generateUUID()" "$WORKTREE_DIR/ui/src/ui/app-chat.ts" \
    && rg -q "runId: string;" "$WORKTREE_DIR/ui/src/ui/ui-types.ts"; then
    ok=1
  fi
  if [[ "$ok" == "1" ]]; then
    echo '{"webchatRetryIdempotencyPatched":true}'
    return 0
  fi
  echo '{"webchatRetryIdempotencyPatched":false}'
  return 42
}

apply_webchat_retry_idempotency_patch_source() {
  WORKTREE_DIR="$WORKTREE_DIR" node - <<'NODE'
const fs = require("fs");
const path = require("path");

const root = process.env.WORKTREE_DIR;
if (!root) throw new Error("WORKTREE_DIR missing");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}
function write(rel, text) {
  fs.writeFileSync(path.join(root, rel), text);
}
function replaceOrThrow(text, from, to, label) {
  if (typeof from === "string") {
    if (!text.includes(from)) throw new Error(`replace target not found: ${label}`);
    return text.replace(from, to);
  }
  if (!from.test(text)) throw new Error(`replace target not found: ${label}`);
  return text.replace(from, to);
}

const controllersRel = "ui/src/ui/controllers/chat.ts";
let controllers = read(controllersRel);
if (!controllers.includes("hasOptimisticEcho")) {
  controllers = replaceOrThrow(
    controllers,
    /export async function sendChatMessage\(\s*state: ChatState,\s*message: string,\s*attachments\?: ChatAttachment\[],\s*\): Promise<string \| null> \{/m,
    `export async function sendChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
  opts?: { runId?: string },
): Promise<string | null> {`,
    "sendChatMessage signature",
  );
  controllers = replaceOrThrow(
    controllers,
    "  const now = Date.now();\n",
    "  const now = Date.now();\n  const runId = opts?.runId ?? generateUUID();\n",
    "runId declaration",
  );
  controllers = replaceOrThrow(
    controllers,
    `  state.chatMessages = [
    ...state.chatMessages,
    {
      role: "user",
      content: contentBlocks,
      timestamp: now,
    },
  ];
`,
    `  const hasOptimisticEcho = state.chatMessages.some((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const idem = (entry as { idempotencyKey?: unknown }).idempotencyKey;
    return typeof idem === "string" && idem === runId;
  });
  if (!hasOptimisticEcho) {
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "user",
        content: contentBlocks,
        timestamp: now,
        idempotencyKey: runId,
      },
    ];
  }
`,
    "optimistic user append",
  );
  controllers = replaceOrThrow(
    controllers,
    "  const runId = generateUUID();\n",
    "",
    "remove old runId",
  );
}
write(controllersRel, controllers);

const typesRel = "ui/src/ui/ui-types.ts";
let types = read(typesRel);
if (!types.includes("runId: string;")) {
  types = replaceOrThrow(types, "export type ChatQueueItem = {\n  id: string;\n", "export type ChatQueueItem = {\n  id: string;\n  runId: string;\n", "chat queue runId");
}
write(typesRel, types);

const appChatRel = "ui/src/ui/app-chat.ts";
let appChat = read(appChatRel);
if (!appChat.includes("runId: next.runId")) {
  appChat = replaceOrThrow(appChat, "      id: generateUUID(),\n", "      id: generateUUID(),\n      runId: generateUUID(),\n", "enqueue runId");
  appChat = replaceOrThrow(appChat, "    attachments?: ChatAttachment[];\n", "    attachments?: ChatAttachment[];\n    runId?: string;\n", "send opts runId");
  appChat = replaceOrThrow(
    appChat,
    "  const runId = await sendChatMessage(host as unknown as OpenClawApp, message, opts?.attachments);\n",
    `  const runId = await sendChatMessage(
    host as unknown as OpenClawApp,
    message,
    opts?.attachments,
    { runId: opts?.runId },
  );
`,
    "sendChatMessage runId passthrough",
  );
  appChat = replaceOrThrow(
    appChat,
    `      ok = await sendChatMessageNow(host, next.text, {
        attachments: next.attachments,
        refreshSessions: next.refreshSessions,
      });
`,
    `      ok = await sendChatMessageNow(host, next.text, {
        attachments: next.attachments,
        runId: next.runId,
        refreshSessions: next.refreshSessions,
      });
`,
    "queue retry runId passthrough",
  );
}
write(appChatRel, appChat);

console.log(
  JSON.stringify(
    {
      patched: true,
      files: [controllersRel, typesRel, appChatRel],
    },
    null,
    2,
  ),
);
NODE
}

check_dns_resolution_health() {
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
  if (out.some((x) => !x.ok)) process.exit(42);
})();
NODE
}

VERSION_INPUT="${1:-}"
if [[ -z "$VERSION_INPUT" ]]; then
  VERSION_INPUT="$(openclaw --version | awk 'NR==1 { print $2 }')"
fi

TAG="$VERSION_INPUT"
if [[ "$TAG" != v* ]]; then
  TAG="v$TAG"
fi

TAG_SLUG="${TAG#v}"
BRANCH_NAME="codex/heartbeat-session-fix-${TAG_SLUG//./-}"
WORKTREE_DIR="$WORKTREE_ROOT/openclaw-${TAG_SLUG}-heartbeat-fix"

echo "==> Using fix source repo: $FIX_REPO"
echo "==> Using fix commit: $FIX_COMMIT"
echo "==> Preparing worktree for tag: $TAG"

if ! fetch_tags; then
  echo "Fetch tags failed. Check network or try again later." >&2
  exit 1
fi

FIX_COMMIT_VALID=1
if ! git -C "$FIX_REPO" rev-parse --verify "${FIX_COMMIT}^{commit}" >/dev/null 2>&1; then
  ALT_FIX_COMMIT="$(git -C "$FIX_REPO" log --grep='Fix heartbeat routing + model selection provider' --format='%H' -n 1 2>/dev/null || true)"
  if [[ -n "${ALT_FIX_COMMIT:-}" ]] && git -C "$FIX_REPO" rev-parse --verify "${ALT_FIX_COMMIT}^{commit}" >/dev/null 2>&1; then
    FIX_COMMIT="$ALT_FIX_COMMIT"
    echo "warn: requested fix commit missing; auto-selected heartbeat fix commit: $FIX_COMMIT" >&2
  else
    echo "warn: fix commit not found in repo; will use fallback patch instead." >&2
    FIX_COMMIT_VALID=0
  fi
else
  echo "==> Using verified fix commit: $FIX_COMMIT"
fi
if [[ "$FIX_COMMIT_VALID" != "1" ]]; then
  FIX_COMMIT_VALID=0
fi
RESOLVED_TAG="$(resolve_tag "$TAG")"
if [[ -z "$RESOLVED_TAG" ]]; then
  echo "Tag not found: $TAG (or ${TAG}-1). Try OPENCLAW_FIX_REPO with a repo that has the tag." >&2
  exit 1
fi
TAG="$RESOLVED_TAG"
TAG_SLUG="${TAG#v}"
BRANCH_NAME="codex/heartbeat-session-fix-${TAG_SLUG//./-}"
WORKTREE_DIR="$WORKTREE_ROOT/openclaw-${TAG_SLUG}-heartbeat-fix"

mkdir -p "$WORKTREE_ROOT"
if [[ -d "$WORKTREE_DIR" ]]; then
  git -C "$FIX_REPO" worktree remove --force "$WORKTREE_DIR" 2>/dev/null || rm -rf "$WORKTREE_DIR"
fi

git -C "$FIX_REPO" worktree prune || true
cleanup_worktree_locks "openclaw-${TAG_SLUG}-heartbeat-fix"

if git -C "$FIX_REPO" show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
  git -C "$FIX_REPO" branch -D "$BRANCH_NAME" >/dev/null 2>&1 || true
fi

git -C "$FIX_REPO" worktree add -B "$BRANCH_NAME" "$WORKTREE_DIR" "$TAG"

apply_fallback_patch() {
  local patch_file="$WORKTREE_DIR/.codex-heartbeat-fallback.patch"
  cat > "$patch_file" <<'EOF'
diff --git a/src/auto-reply/reply/session-delivery.ts b/src/auto-reply/reply/session-delivery.ts
index 2f88fe0..0e8f6c4 100644
--- a/src/auto-reply/reply/session-delivery.ts
+++ b/src/auto-reply/reply/session-delivery.ts
@@ -10,6 +10,7 @@ import {
   INTERNAL_MESSAGE_CHANNEL,
   isDeliverableMessageChannel,
   normalizeMessageChannel,
 } from "../../utils/message-channel.js";
+import { isSyntheticSessionEventProvider } from "../../utils/system-turn-provider.js";
 import type { MsgContext } from "../templating.js";
@@ -80,15 +81,22 @@ export function resolveLastChannelRaw(params: {
 }): string | undefined {
   const originatingChannel = normalizeMessageChannel(params.originatingChannelRaw);
-  // WebChat should own reply routing for direct-session UI turns, even when the
-  // session previously replied through an external channel like iMessage.
-  if (
-    originatingChannel === INTERNAL_MESSAGE_CHANNEL &&
-    (isMainSessionKey(params.sessionKey) || isDirectSessionKey(params.sessionKey))
-  ) {
-    return params.originatingChannelRaw;
-  }
   const persistedChannel = normalizeMessageChannel(params.persistedLastChannel);
   const sessionKeyChannelHint = resolveSessionKeyChannelHint(params.sessionKey);
+  // WebChat should own reply routing for direct-session UI turns, but only when
+  // the session has no established external delivery route. If the session was
+  // created via an external channel (e.g. Telegram, iMessage), webchat/dashboard
+  // access must not overwrite the persisted route — doing so causes subagent
+  // completion events to be delivered to the dashboard instead of the original
+  // channel. See: https://github.com/openclaw/openclaw/issues/47745
+  const hasEstablishedExternalRoute =
+    isExternalRoutingChannel(persistedChannel) || isExternalRoutingChannel(sessionKeyChannelHint);
+  if (
+    originatingChannel === INTERNAL_MESSAGE_CHANNEL &&
+    !hasEstablishedExternalRoute &&
+    (isMainSessionKey(params.sessionKey) || isDirectSessionKey(params.sessionKey))
+  ) {
+    return params.originatingChannelRaw;
+  }
   let resolved = params.originatingChannelRaw || params.persistedLastChannel;
@@ -108,19 +116,31 @@ export function resolveLastToRaw(params: {
   originatingChannelRaw?: string;
   originatingToRaw?: string;
+  providerRaw?: string;
   toRaw?: string;
   persistedLastTo?: string;
   persistedLastChannel?: string;
   sessionKey?: string;
 }): string | undefined {
   const originatingChannel = normalizeMessageChannel(params.originatingChannelRaw);
-  if (
-    originatingChannel === INTERNAL_MESSAGE_CHANNEL &&
-    (isMainSessionKey(params.sessionKey) || isDirectSessionKey(params.sessionKey))
-  ) {
-    return params.originatingToRaw || params.toRaw;
-  }
   const persistedChannel = normalizeMessageChannel(params.persistedLastChannel);
   const sessionKeyChannelHint = resolveSessionKeyChannelHint(params.sessionKey);
+  const hasEstablishedExternalRouteForTo =
+    isExternalRoutingChannel(persistedChannel) || isExternalRoutingChannel(sessionKeyChannelHint);
+  if (
+    originatingChannel === INTERNAL_MESSAGE_CHANNEL &&
+    !hasEstablishedExternalRouteForTo &&
+    (isMainSessionKey(params.sessionKey) || isDirectSessionKey(params.sessionKey))
+  ) {
+    return params.originatingToRaw || params.toRaw;
+  }
+  const ignoreSyntheticSystemTarget =
+    !originatingChannel && isSyntheticSessionEventProvider(params.providerRaw);
+  if (ignoreSyntheticSystemTarget) {
+    return params.originatingToRaw || params.persistedLastTo;
+  }
diff --git a/src/auto-reply/reply/session.ts b/src/auto-reply/reply/session.ts
index 8f0e02b..56a3d2c 100644
--- a/src/auto-reply/reply/session.ts
+++ b/src/auto-reply/reply/session.ts
@@ -389,6 +389,7 @@ const lastToRaw = resolveLastToRaw({
   originatingChannelRaw,
   originatingToRaw: ctx.OriginatingTo,
+  providerRaw: ctx.Provider,
   toRaw: ctx.To,
   persistedLastTo: baseEntry?.lastTo,
   persistedLastChannel: baseEntry?.lastChannel,
diff --git a/src/config/sessions/metadata.ts b/src/config/sessions/metadata.ts
index 7c8ec3e..a4c8f09 100644
--- a/src/config/sessions/metadata.ts
+++ b/src/config/sessions/metadata.ts
@@ -3,6 +3,7 @@ import { normalizeChatType } from "../../channels/chat-type.js";
 import { resolveConversationLabel } from "../../channels/conversation-label.js";
 import { getChannelDock } from "../../channels/dock.js";
 import { normalizeChannelId } from "../../channels/plugins/index.js";
 import { normalizeMessageChannel } from "../../utils/message-channel.js";
+import { isSyntheticSessionEventProvider } from "../../utils/system-turn-provider.js";
 import { buildGroupDisplayName, resolveGroupSessionKey } from "./group.js";
 import type { GroupKeyResolution, SessionEntry, SessionOrigin } from "./types.js";
@@ -31,14 +32,20 @@ const mergeOrigin = (
 export function deriveSessionOrigin(ctx: MsgContext): SessionOrigin | undefined {
-  const label = resolveConversationLabel(ctx)?.trim();
-  const providerRaw =
-    (typeof ctx.OriginatingChannel === "string" && ctx.OriginatingChannel) ||
-    ctx.Surface ||
-    ctx.Provider;
+  const originatingChannel = normalizeMessageChannel(ctx.OriginatingChannel);
+  const ignoreSyntheticSystemOrigin =
+    !originatingChannel && isSyntheticSessionEventProvider(ctx.Provider);
+  const label = ignoreSyntheticSystemOrigin ? undefined : resolveConversationLabel(ctx)?.trim();
+  const providerRaw = ignoreSyntheticSystemOrigin
+    ? undefined
+    : (typeof ctx.OriginatingChannel === "string" && ctx.OriginatingChannel) ||
+      ctx.Surface ||
+      ctx.Provider;
   const provider = normalizeMessageChannel(providerRaw);
   const surface = ctx.Surface?.trim().toLowerCase();
   const chatType = normalizeChatType(ctx.ChatType) ?? undefined;
-  const from = ctx.From?.trim();
-  const to =
-    (typeof ctx.OriginatingTo === "string" ? ctx.OriginatingTo : ctx.To)?.trim() ?? undefined;
+  const from = ignoreSyntheticSystemOrigin ? undefined : ctx.From?.trim();
+  const to = (
+    ignoreSyntheticSystemOrigin
+      ? ctx.OriginatingTo
+      : typeof ctx.OriginatingTo === "string"
+        ? ctx.OriginatingTo
+        : ctx.To
+  )?.trim();
diff --git a/src/agents/model-selection.ts b/src/agents/model-selection.ts
index 5cc4c0c..9b2d404 100644
--- a/src/agents/model-selection.ts
+++ b/src/agents/model-selection.ts
@@ -556,12 +556,49 @@ export function resolveAllowedModelRef(params: {
   if (!trimmed) {
     return { error: "invalid model: empty" };
   }
+
+  const allowed = buildAllowedModelSet({
+    cfg: params.cfg,
+    catalog: params.catalog,
+    defaultProvider: params.defaultProvider,
+    defaultModel: params.defaultModel,
+  });
   const aliasIndex = buildModelAliasIndex({
     cfg: params.cfg,
     defaultProvider: params.defaultProvider,
   });
-  const resolved = resolveModelRefFromString({
-    raw: trimmed,
-    defaultProvider: params.defaultProvider,
-    aliasIndex,
-  });
+  const rawHasProvider = trimmed.includes("/");
+  let resolved: { ref: ModelRef; alias?: string } | null = null;
+  if (!rawHasProvider) {
+    const aliasKey = normalizeAliasKey(trimmed);
+    const aliasMatch = aliasIndex.byAlias.get(aliasKey);
+    if (aliasMatch) {
+      resolved = {
+        ref: aliasMatch.ref,
+        alias: aliasMatch.alias,
+      };
+    } else {
+      const normalized = trimmed.toLowerCase();
+      const candidates = params.catalog.filter(
+        (entry) => entry.id.trim().toLowerCase() === normalized,
+      );
+      const allowedCandidates = candidates.filter(
+        (entry) => allowed.allowAny || allowed.allowedKeys.has(modelKey(entry.provider, entry.id)),
+      );
+      if (allowedCandidates.length === 1) {
+        const match = allowedCandidates[0];
+        resolved = { ref: { provider: match.provider, model: match.id } };
+      } else if (allowedCandidates.length > 1) {
+        const defaultMatch = allowedCandidates.find(
+          (entry) => entry.provider?.trim().toLowerCase() === params.defaultProvider.toLowerCase(),
+        );
+        if (defaultMatch) {
+          resolved = { ref: { provider: defaultMatch.provider, model: defaultMatch.id } };
+        }
+      } else if (candidates.length === 1) {
+        const match = candidates[0];
+        resolved = { ref: { provider: match.provider, model: match.id } };
+      }
+    }
+  }
+  if (!resolved) {
+    resolved = resolveModelRefFromString({
+      raw: trimmed,
+      defaultProvider: params.defaultProvider,
+      aliasIndex,
+    });
+  }
   if (!resolved) {
     return { error: `invalid model: ${trimmed}` };
   }
diff --git a/src/utils/system-turn-provider.ts b/src/utils/system-turn-provider.ts
new file mode 100644
index 0000000..3ad2c0d
--- /dev/null
+++ b/src/utils/system-turn-provider.ts
@@ -0,0 +1,6 @@
+const SYNTHETIC_SESSION_EVENT_PROVIDERS = new Set(["heartbeat", "cron-event", "exec-event"]);
+
+export function isSyntheticSessionEventProvider(provider?: string): boolean {
+  const normalized = provider?.trim().toLowerCase();
+  return normalized ? SYNTHETIC_SESSION_EVENT_PROVIDERS.has(normalized) : false;
+}
diff --git a/src/auto-reply/reply/session-delivery.test.ts b/src/auto-reply/reply/session-delivery.test.ts
index b91d0db..0e1b9c0 100644
--- a/src/auto-reply/reply/session-delivery.test.ts
+++ b/src/auto-reply/reply/session-delivery.test.ts
@@ -1,6 +1,54 @@
 import { describe, expect, it } from "vitest";
 import { resolveLastChannelRaw, resolveLastToRaw } from "./session-delivery.js";

 describe("session delivery direct-session routing overrides", () => {
+  it.each([
+    "agent:main:direct:user-1",
+    "agent:main:telegram:direct:123456",
+    "agent:main:telegram:account-a:direct:123456",
+    "agent:main:telegram:dm:123456",
+    "agent:main:telegram:direct:123456:thread:99",
+    "agent:main:telegram:account-a:direct:123456:topic:ops",
+  ])(
+    "preserves persisted external route when webchat accesses channel-peer session %s (fixes #47745)",
+    (sessionKey) => {
+      // Webchat/dashboard viewing an external-channel session must not overwrite
+      // the delivery route — subagents must still deliver to the original channel.
+      expect(
+        resolveLastChannelRaw({
+          originatingChannelRaw: "webchat",
+          persistedLastChannel: "telegram",
+          sessionKey,
+        }),
+      ).toBe("telegram");
+      expect(
+        resolveLastToRaw({
+          originatingChannelRaw: "webchat",
+          originatingToRaw: "session:dashboard",
+          persistedLastChannel: "telegram",
+          persistedLastTo: "123456",
+          sessionKey,
+        }),
+      ).toBe("123456");
+    },
+  );
+
+  it.each([
+    "agent:main:main:direct",
+    "agent:main:cron:job-1:dm",
+    "agent:main:subagent:worker:direct:user-1",
+    "agent:main:telegram:channel:direct",
+    "agent:main:telegram:account-a:direct",
+    "agent:main:telegram:direct:123456:cron:job-1",
+  ])("keeps persisted external routes for malformed direct-like key %s", (sessionKey) => {
+    expect(
+      resolveLastChannelRaw({
+        originatingChannelRaw: "webchat",
+        persistedLastChannel: "telegram",
+        sessionKey,
+      }),
+    ).toBe("telegram");
+    expect(
+      resolveLastToRaw({
+        originatingChannelRaw: "webchat",
+        originatingToRaw: "session:dashboard",
+        persistedLastChannel: "telegram",
+        persistedLastTo: "group:12345",
+        sessionKey,
+      }),
+    ).toBe("group:12345");
+  });
+
diff --git a/src/auto-reply/reply/session.test.ts b/src/auto-reply/reply/session.test.ts
index 1f580a9..c589e5f 100644
--- a/src/auto-reply/reply/session.test.ts
+++ b/src/auto-reply/reply/session.test.ts
@@ -1976,10 +1976,10 @@ describe("initSessionState internal channel routing preservation", () => {
     });

-    expect(result.sessionEntry.lastChannel).toBe("webchat");
-    expect(result.sessionEntry.lastTo).toBe("session:dashboard");
-    expect(result.sessionEntry.deliveryContext?.channel).toBe("webchat");
-    expect(result.sessionEntry.deliveryContext?.to).toBe("session:dashboard");
+    expect(result.sessionEntry.lastChannel).toBe("imessage");
+    expect(result.sessionEntry.lastTo).toBe("+1555");
+    expect(result.sessionEntry.deliveryContext?.channel).toBe("imessage");
+    expect(result.sessionEntry.deliveryContext?.to).toBe("+1555");
   });
@@ -2098,8 +2098,8 @@ describe("initSessionState internal channel routing preservation", () => {
     });

-    expect(result.sessionEntry.lastChannel).toBe("webchat");
-    expect(result.sessionEntry.lastTo).toBeUndefined();
+    expect(result.sessionEntry.lastChannel).toBe("whatsapp");
+    expect(result.sessionEntry.lastTo).toBe("+15555550123");
   });
@@ -2130,10 +2130,10 @@ describe("initSessionState internal channel routing preservation", () => {
     });

-    expect(result.sessionEntry.lastChannel).toBe("webchat");
-    expect(result.sessionEntry.lastTo).toBe("session:webchat-main");
-    expect(result.sessionEntry.deliveryContext?.channel).toBe("webchat");
-    expect(result.sessionEntry.deliveryContext?.to).toBe("session:webchat-main");
+    expect(result.sessionEntry.lastChannel).toBe("whatsapp");
+    expect(result.sessionEntry.lastTo).toBe("+15555550123");
+    expect(result.sessionEntry.deliveryContext?.channel).toBe("whatsapp");
+    expect(result.sessionEntry.deliveryContext?.to).toBe("+15555550123");
   });
EOF

  if ! git -C "$WORKTREE_DIR" apply --3way "$patch_file"; then
    echo "Fallback patch failed. Please resolve conflicts in: $WORKTREE_DIR" >&2
    exit 1
  fi
  git -C "$WORKTREE_DIR" add \
    src/auto-reply/reply/session-delivery.ts \
    src/auto-reply/reply/session.ts \
    src/config/sessions/metadata.ts \
    src/agents/model-selection.ts \
    src/utils/system-turn-provider.ts \
    src/auto-reply/reply/session-delivery.test.ts \
    src/auto-reply/reply/session.test.ts
  git -C "$WORKTREE_DIR" commit -m "Apply heartbeat routing + model selection provider fixes"
}

if rg -q "ignoreSyntheticSystemTarget" "$WORKTREE_DIR/src/auto-reply/reply/session-delivery.ts" \
  && rg -q "ignoreSyntheticSystemOrigin" "$WORKTREE_DIR/src/config/sessions/metadata.ts"; then
  echo "==> Upstream already contains the heartbeat session fix, skipping cherry-pick"
else
  if [[ "$FIX_COMMIT_VALID" == "1" ]]; then
    echo "==> Cherry-picking heartbeat session fix"
    if ! git -C "$WORKTREE_DIR" cherry-pick -x "$FIX_COMMIT"; then
      git -C "$WORKTREE_DIR" cherry-pick --abort || true
      echo "Cherry-pick failed; applying fallback patch." >&2
      apply_fallback_patch
    fi
  else
    echo "==> Fix commit missing; applying fallback patch"
    apply_fallback_patch
  fi
fi

echo "==> Checking webchat retry/idempotency patch (duplicate send protection)"
if ! check_webchat_retry_idempotency_patch_source; then
  echo "==> Applying webchat retry/idempotency patch"
  apply_webchat_retry_idempotency_patch_source
  check_webchat_retry_idempotency_patch_source
  if ! git -C "$WORKTREE_DIR" diff --quiet -- \
    ui/src/ui/controllers/chat.ts \
    ui/src/ui/app-chat.ts \
    ui/src/ui/ui-types.ts; then
    git -C "$WORKTREE_DIR" add \
      ui/src/ui/controllers/chat.ts \
      ui/src/ui/app-chat.ts \
      ui/src/ui/ui-types.ts
    git -C "$WORKTREE_DIR" commit -m "fix(webchat): keep idempotency key stable across queue retries"
  fi
fi

echo "==> Installing dependencies"
pnpm install --frozen-lockfile --dir "$WORKTREE_DIR"

echo "==> Running targeted regression tests"
cd "$WORKTREE_DIR"
pnpm exec vitest run \
  src/auto-reply/reply/session-delivery.test.ts \
  src/auto-reply/reply/session.test.ts

pnpm exec vitest run --config vitest.unit.config.ts \
  src/infra/outbound/targets.test.ts \
  src/infra/heartbeat-runner.sender-prefers-delivery-target.test.ts

pnpm exec vitest run \
  ui/src/ui/controllers/chat.test.ts \
  ui/src/ui/app-chat.test.ts

echo "==> Building OpenClaw"
pnpm run build
pnpm run ui:build

echo "==> Packing patched build"
PACKAGE_TGZ="$(cd "$WORKTREE_DIR" && npm pack | tail -n 1)"

echo "==> Installing patched build globally"
npm install -g "$WORKTREE_DIR/$PACKAGE_TGZ"

echo "==> Checking toolMsg.content.filter guard status"
if ! check_toolmsg_filter_guard_installed; then
  echo "warn: detected unguarded toolMsg.content.filter in installed pi-agent-core; applying hotfix" >&2
  apply_toolmsg_filter_hotfix_installed
  check_toolmsg_filter_guard_installed
fi

echo "==> Clearing Telegram webhooks to avoid polling conflicts"
if ! clear_telegram_webhooks_from_config; then
  echo "warn: failed to clear one or more Telegram webhooks (network/token issues); continuing" >&2
fi

echo "==> Checking model failover resilience"
if ! check_model_failover_resilience; then
  echo "warn: model failover resilience is weak; update agents.defaults.model.primary/fallbacks in ~/.openclaw/openclaw.json" >&2
fi

echo "==> Ensuring Telegram/Discord retry policy baseline"
if ! ensure_channel_retry_policy_baseline; then
  echo "warn: failed to apply retry policy baseline; verify ~/.openclaw/openclaw.json" >&2
fi

echo "==> Checking DNS resolution health (telegram + feishu)"
if ! check_dns_resolution_health; then
  echo "warn: DNS lookup failed for one or more critical endpoints; check resolver/proxy/network" >&2
fi

echo "==> Summarizing top log hotspots (last 5 days)"
summarize_gateway_error_hotspots

echo "==> Restarting gateway"
openclaw gateway restart
sleep 3

echo "==> Installed version"
openclaw --version

echo "==> Gateway health"
openclaw gateway health

echo "==> Checking main session pollution status"
if ! check_main_session_pollution; then
  echo "warn: heartbeat pollution detected after install; sanitizing session store and restarting gateway" >&2
  sanitize_main_session_store
  openclaw gateway restart
  sleep 2
  check_main_session_pollution
fi

echo "==> Done"
echo "Worktree: $WORKTREE_DIR"
