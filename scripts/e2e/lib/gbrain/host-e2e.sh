#!/usr/bin/env bash
# GBrain plugin end-to-end on a clean POSIX host (Linux with a systemd user bus, or macOS
# with a logged-in GUI session). Installs a packed OpenClaw and the packed gbrain plugin,
# then proves recall, one PGLite holder, probe, inspect, doctor, faults, upgrade and uninstall.
#
# Inputs (env): OC_TGZ, PLUGIN_TGZ, OPENAI_KEY_FILE (0600), WORK (scratch dir),
# optional GATEWAY_PORT (default 19431), MODEL (default openai/gpt-5.6-sol).
# Output: $WORK/friction.jsonl (one line per step) and $WORK/logs/*.
set -uo pipefail

: "${OC_TGZ:?}" "${PLUGIN_TGZ:?}" "${OPENAI_KEY_FILE:?}" "${WORK:?}"
GATEWAY_PORT="${GATEWAY_PORT:-19431}"
MODEL="${MODEL:-openai/gpt-5.6-sol}"
mkdir -p "$WORK/logs" "$WORK/prefix"
FRICTION="$WORK/friction.jsonl"
: >"$FRICTION"
export PATH="$WORK/prefix/bin:$WORK/node/bin:$HOME/.bun/bin:$PATH"
OS="$(uname -s)"
FAILED=0

redact() { sed -E 's/gbrain_[A-Za-z0-9_-]{12,}/gbrain_<redacted>/g; s/sk-[A-Za-z0-9_-]{12,}/sk-<redacted>/g'; }
now() { date +%s; }
# step NAME CMD...: run, time, log, and record one friction line (exit, seconds, last output line).
step() {
  local name="$1"
  shift
  local started out code last
  started="$(now)"
  out="$("$@" 2>&1)"
  code=$?
  printf '%s\n' "$out" | redact >"$WORK/logs/$name.log"
  last="$(printf '%s\n' "$out" | redact | grep -v '^\s*$' | tail -1 | cut -c1-400)"
  node -e 'const [n,c,s,l]=process.argv.slice(1);console.log(JSON.stringify({step:n,exit:+c,seconds:+s,last:l}))' \
    "$name" "$code" "$(($(now) - started))" "$last" >>"$FRICTION"
  return "$code"
}
fail() {
  echo "FAIL: $*" | tee -a "$WORK/logs/failures.log"
  FAILED=1
}
oc() { openclaw "$@"; }

ensure_node() {
  if command -v node >/dev/null 2>&1 && node -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)'; then
    return 0
  fi
  local arch platform version=v24.22.1
  arch="$(uname -m)"
  [ "$arch" = "x86_64" ] && arch=x64
  [ "$arch" = "aarch64" ] && arch=arm64
  platform="$(echo "$OS" | tr '[:upper:]' '[:lower:]')"
  mkdir -p "$WORK/node"
  curl -fsSL "https://nodejs.org/dist/$version/node-$version-$platform-$arch.tar.xz" | tar -xJ -C "$WORK/node" --strip-components=1
}

gateway_start() {
  nohup openclaw gateway run --port "$GATEWAY_PORT" >>"$WORK/logs/gateway.out" 2>&1 &
  echo $! >"$WORK/gateway.pid"
  for _ in $(seq 1 120); do
    curl -fsS "http://127.0.0.1:$GATEWAY_PORT/readyz" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
gateway_stop() {
  local pid
  pid="$(cat "$WORK/gateway.pid" 2>/dev/null)" || return 0
  kill "$pid" 2>/dev/null
  for _ in $(seq 1 60); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  kill -9 "$pid" 2>/dev/null
}
config_server() {
  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify(c.mcp?.servers?.gbrain??null))' "$HOME/.openclaw/openclaw.json"
}
wait_connected() {
  for _ in $(seq 1 "${1:-300}"); do
    if config_server | grep -q 'streamable-http' && grep -q 'connected as MCP server' "$WORK/logs/gateway.out"; then
      return 0
    fi
    sleep 1
  done
  return 1
}
# turn KEY MESSAGE CODEWORD: real model turn; passes when the reply has the codeword and a gbrain tool ran.
turn() {
  local key="$1" message="$2" codeword="$3"
  oc agent --agent main --session-key "agent:main:$key" --message "$message" --json --timeout 300 >"$WORK/logs/turn-$key.json" 2>&1 || return 1
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const text = JSON.stringify(r.result?.payloads ?? r.result ?? r);
    const tools = r.result?.meta?.agentMeta?.terminalReceipt?.successfulToolNames ?? [];
    const ok = text.includes(process.argv[2]) && tools.some((t) => t.startsWith("gbrain__"));
    console.log(JSON.stringify({ codeword: text.includes(process.argv[2]), tools }));
    process.exit(ok ? 0 : 1);
  ' "$WORK/logs/turn-$key.json" "$codeword"
}
pglite_holders() { lsof -t +D "$HOME/.gbrain/brain.pglite" 2>/dev/null | sort -u | wc -l | tr -d ' '; }
seed() {
  local slug
  slug="projects/$(echo "$1" | tr '[:upper:] ' '[:lower:]-')"
  printf -- '---\ntitle: %s\n---\n# %s\n\n%s\n' "$1" "$1" "$2" | gbrain put "$slug"
}
codeword() {
  node -e 'const w=["AMBER","COBALT","FERN","GARNET","JUNIPER","MAPLE","ONYX","SAFFRON","TEAL","UMBER"];const a=()=>w[Math.floor(Math.random()*w.length)];console.log(`${a()}-${a()}-${Math.floor(1000+Math.random()*9000)}`)'
}
service_stop() {
  if [ "$OS" = Darwin ]; then
    launchctl bootout "gui/$(id -u)/com.gbrain.serve"
  else
    systemctl --user stop gbrain-serve.service
  fi
}
service_start() {
  if [ "$OS" = Darwin ]; then
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.gbrain.serve.plist"
  else
    systemctl --user start gbrain-serve.service
  fi
}
health_ok() {
  for _ in $(seq 1 "${1:-60}"); do
    curl -fsS http://127.0.0.1:3131/health >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
key_hash() { config_server | shasum | cut -c1-12; }
revoke_openclaw_keys() {
  local admin jar ids id
  admin="$(cat "$HOME/.gbrain/serve/admin-token")"
  jar="$(mktemp)"
  curl -fsS -c "$jar" -H "Content-Type: application/json" -d "{\"token\":\"$admin\"}" http://127.0.0.1:3131/admin/login >/dev/null
  ids="$(curl -fsS -b "$jar" http://127.0.0.1:3131/admin/api/api-keys |
    node -e 'for (const k of JSON.parse(require("fs").readFileSync(0,"utf8"))) if (k.name==="openclaw"&&k.status==="active") console.log(k.id)')"
  for id in $ids; do
    curl -fsS -b "$jar" -H "Content-Type: application/json" -d "{\"id\":\"$id\"}" http://127.0.0.1:3131/admin/api/api-keys/revoke
    echo
  done
  rm -f "$jar"
}
installed_index_has_gbrain() {
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const row = db.prepare("select value_json from config_machine_state where state_key = ?").get("plugins.installedIndex");
    const index = row ? JSON.parse(row.value_json).index : {};
    const present = Boolean(index.installRecords?.gbrain) || (index.plugins ?? []).some((p) => p.pluginId === "gbrain");
    console.log(JSON.stringify({ present }));
    process.exit(present ? 0 : 1);
  ' "$HOME/.openclaw/state/openclaw.sqlite"
}

no_gbrain_record() { ! installed_index_has_gbrain; }

# 1. OpenClaw, isolated to this user, with a real model.
step node ensure_node || fail "node"
step install-openclaw npm install -g --prefix "$WORK/prefix" "$OC_TGZ" || fail "install openclaw"
step onboard oc onboard --non-interactive --accept-risk --mode local --flow quickstart --auth-choice skip \
  --gateway-port "$GATEWAY_PORT" --gateway-bind loopback --no-install-daemon --skip-channels --skip-search \
  --skip-skills --skip-ui --skip-health --skip-hooks || fail "onboard"
step model-secret oc config set secrets.providers.oaikey \
  "{\"source\":\"file\",\"path\":\"$OPENAI_KEY_FILE\",\"mode\":\"singleValue\"}" --strict-json || fail "secret"
step model-provider oc config set models.providers.openai \
  '{"apiKey":{"source":"file","provider":"oaikey","id":"value"},"agentRuntime":{"id":"openclaw"}}' --strict-json || fail "provider"
step model-default oc config set agents.defaults.model "\"$MODEL\"" --strict-json || fail "model"
step gateway-start gateway_start || fail "gateway start"

# 2. One install request, as the Control UI sends it. A clean host has no Bun: record what the user sees.
step plugin-install oc gateway call plugins.install --timeout 600000 --json \
  --params "{\"source\":\"npm-pack\",\"archivePath\":\"$PLUGIN_TGZ\",\"enable\":true}" || fail "plugins.install"
if ! command -v bun >/dev/null 2>&1; then
  sleep 10
  step bun-missing-message grep -m1 'GBrain needs Bun' "$WORK/logs/gateway.out" || fail "no Bun message"
  step bun-install bash -c 'curl -fsSL https://bun.sh/install | bash' || fail "bun install"
fi
step connect wait_connected 600 || fail "plugin did not connect"
step inspect-runtime bash -c 'openclaw plugins inspect gbrain --runtime --json | node -e "const r=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));console.log(JSON.stringify({status:r.plugin.status,imported:r.plugin.imported,activated:r.plugin.activated}));process.exit(r.plugin.status===\"loaded\"?0:1)"' || fail "inspect"

# 3. Seed a codeword no session has seen, restart, probe offline, recall without saying where to look.
CW1="$(codeword)"
step seed seed "Project Osprey" "The Osprey vault phrase is $CW1." || fail "seed"
step gateway-stop gateway_stop
step mcp-probe oc mcp probe gbrain || fail "mcp probe"
step gateway-restart gateway_start || fail "restart"
step recall turn "e2e-recall-$RANDOM" "What is the Osprey vault phrase?" "$CW1" || fail "recall after restart"

# 4. Two concurrent sessions: exactly one process holds brain.pglite.
CW2="$(codeword)"
CW3="$(codeword)"
seed "Project Heron" "The Heron launch phrase is $CW2." >/dev/null 2>&1
seed "Project Kestrel" "The Kestrel door code is $CW3." >/dev/null 2>&1
turn "e2e-par-a-$RANDOM" "What is the Heron launch phrase?" "$CW2" >"$WORK/logs/par-a.out" 2>&1 &
PA=$!
turn "e2e-par-b-$RANDOM" "What is the Kestrel door code?" "$CW3" >"$WORK/logs/par-b.out" 2>&1 &
PB=$!
MAXH=0
while kill -0 "$PA" 2>/dev/null || kill -0 "$PB" 2>/dev/null; do
  h="$(pglite_holders)"
  [ "$h" -gt "$MAXH" ] && MAXH="$h"
  sleep 1
done
RA=0
RB=0
wait "$PA" || RA=1
wait "$PB" || RB=1
step concurrent-holders bash -c "lsof +D '$HOME/.gbrain/brain.pglite' 2>/dev/null | awk 'NR>1{print \$1, \$2}' | sort -u; echo max_holders=$MAXH parA=$RA parB=$RB; [ $MAXH -eq 1 ] && [ $RA -eq 0 ] && [ $RB -eq 0 ]" || fail "concurrency"

step gbrain-doctor gbrain doctor || fail "gbrain doctor"

# 5. Faults.
step fault-stop-service service_stop
sleep 70
step fault-stop-reported grep -m1 "GBrain's service is not answering" "$WORK/logs/gateway.out" || fail "stopped service not reported"
step fault-start-service service_start
health_ok 60
CW4="$(codeword)"
seed "Project Plover" "The Plover badge number is $CW4." >/dev/null 2>&1
step fault-stop-recovered turn "e2e-after-stop-$RANDOM" "What is the Plover badge number?" "$CW4" || fail "recall after service restart"

CW5="$(codeword)"
seed "Project Wren" "The Wren gate phrase is $CW5." >/dev/null 2>&1
turn "e2e-kill-$RANDOM" "What is the Wren gate phrase?" "$CW5" >"$WORK/logs/kill-turn.out" 2>&1 &
KT=$!
sleep 6
SERVE_PID="$(lsof -t +D "$HOME/.gbrain/brain.pglite" 2>/dev/null | head -1)"
step fault-kill-serve kill -9 "$SERVE_PID"
KILL_TURN=0
wait "$KT" || KILL_TURN=1
echo "turn-during-kill exit=$KILL_TURN" >>"$WORK/logs/kill-turn.out"
step fault-kill-supervisor-restart health_ok 90 || fail "supervisor did not restart serve"
CW6="$(codeword)"
seed "Project Tern" "The Tern ledger code is $CW6." >/dev/null 2>&1
step fault-kill-recovered turn "e2e-after-kill-$RANDOM" "What is the Tern ledger code?" "$CW6" || fail "recall after kill"

BEFORE="$(key_hash)"
step fault-rotate-token revoke_openclaw_keys || fail "revoke"
for _ in $(seq 1 90); do
  [ "$(key_hash)" != "$BEFORE" ] && break
  sleep 1
done
step fault-rotate-reminted test "$(key_hash)" != "$BEFORE" || fail "key not re-minted"
CW7="$(codeword)"
seed "Project Avocet" "The Avocet seal is $CW7." >/dev/null 2>&1
step fault-rotate-recovered turn "e2e-after-rotate-$RANDOM" "What is the Avocet seal?" "$CW7" || fail "recall after rotation"

# 6. gbrain upgrade with no plugin change: go back one release, then let GBrain upgrade itself.
PREV="$(gbrain --version)"
step upgrade-downgrade bash -c 'bun install -g "github:garrytan/gbrain#v0.60.732.0" && gbrain --version'
step upgrade-run bash -c 'gbrain upgrade; gbrain --version'
health_ok 120
CW8="$(codeword)"
seed "Project Godwit" "The Godwit beacon is $CW8." >/dev/null 2>&1
step upgrade-recall turn "e2e-after-upgrade-$RANDOM" "What is the Godwit beacon?" "$CW8" || fail "recall after gbrain upgrade (was $PREV)"

# 7. Uninstall: no install record; GBrain's service and brain untouched.
step uninstall oc plugins uninstall gbrain --force || fail "uninstall"
step uninstall-no-record no_gbrain_record || fail "install record left"
step uninstall-service-kept health_ok 10 || fail "service gone after uninstall"
step uninstall-brain-kept test -d "$HOME/.gbrain/brain.pglite" || fail "brain gone"

gateway_stop
echo "done failed=$FAILED"
exit "$FAILED"
