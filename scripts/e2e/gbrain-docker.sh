#!/usr/bin/env bash
# Live Docker lane for the GBrain plugin: the repository docker-compose.yml plus the
# deploy/gbrain/compose.yaml overlay, a released OpenClaw image, and the packed plugin.
# Proves install, recall after restart, one PGLite holder, probe, inspect, doctor,
# faults, gbrain upgrade and uninstall. Needs OPENAI_API_KEY (live model). Packs the plugin
# with scripts/plugin-npm-publish.sh unless OPENCLAW_GBRAIN_PLUGIN_TGZ names a tarball.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${OPENAI_API_KEY:?OPENAI_API_KEY is required for the live model turns}"
export OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-ghcr.io/openclaw/openclaw:latest}"
MODEL="${OPENCLAW_GBRAIN_E2E_MODEL:-openai/gpt-5.6-sol}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-gbrain-docker.XXXXXX")"
PROJECT="gbrain-e2e-$$"
FRICTION="$WORK/friction.jsonl"
FAILED=0
mkdir -p "$WORK/state/workspace" "$WORK/auth" "$WORK/e2e" "$WORK/logs" "$WORK/pack"
chmod 777 "$WORK/state" "$WORK/state/workspace" "$WORK/auth"
if [ -z "${OPENCLAW_GBRAIN_PLUGIN_TGZ:-}" ]; then
  OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR="$WORK/pack" bash "$ROOT_DIR/scripts/plugin-npm-publish.sh" --pack extensions/gbrain >"$WORK/logs/pack.log" 2>&1 ||
    { echo "packing extensions/gbrain failed; see $WORK/logs/pack.log" >&2; exit 1; }
  OPENCLAW_GBRAIN_PLUGIN_TGZ="$(ls "$WORK"/pack/openclaw-gbrain-*.tgz)"
fi
cp "$OPENCLAW_GBRAIN_PLUGIN_TGZ" "$WORK/e2e/plugin.tgz"
(umask 077 && printf %s "$OPENAI_API_KEY" >"$WORK/e2e/openai.key")
chmod 644 "$WORK/e2e/openai.key" "$WORK/e2e/plugin.tgz"
export OPENCLAW_CONFIG_DIR="$WORK/state" OPENCLAW_WORKSPACE_DIR="$WORK/state/workspace"
export OPENCLAW_AUTH_PROFILE_SECRET_DIR="$WORK/auth"
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GBRAIN_E2E_PORT:-28789}" OPENCLAW_BRIDGE_PORT=0 OPENCLAW_MSTEAMS_PORT=0
export OPENCLAW_GATEWAY_TOKEN="gbrain-e2e-$RANDOM$RANDOM"
cat >"$WORK/e2e.compose.yaml" <<EOF
services:
  openclaw-gateway:
    ports: !override
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"
    volumes:
      - $WORK/e2e:/e2e:ro
EOF

compose() {
  docker compose -p "$PROJECT" -f "$ROOT_DIR/docker-compose.yml" -f "$ROOT_DIR/deploy/gbrain/compose.yaml" -f "$WORK/e2e.compose.yaml" "$@"
}
oc() { compose exec -T openclaw-gateway node dist/index.js "$@"; }
gb() { compose exec -T gbrain gbrain "$@"; }
redact() { sed -E 's/gbrain_[A-Za-z0-9_-]{12,}/gbrain_<redacted>/g; s/sk-[A-Za-z0-9_-]{12,}/sk-<redacted>/g'; }
now() { date +%s; }
step() {
  local name="$1" started out code last
  shift
  started="$(now)"
  out="$("$@" 2>&1)"
  code=$?
  printf '%s\n' "$out" | redact >"$WORK/logs/$name.log"
  last="$(printf '%s\n' "$out" | redact | grep -v '^\s*$' | tail -1 | cut -c1-400)"
  node -e 'const [n,c,s,l]=process.argv.slice(1);console.log(JSON.stringify({step:n,exit:+c,seconds:+s,last:l}))' \
    "$name" "$code" "$(($(now) - started))" "$last" | tee -a "$FRICTION"
  return "$code"
}
fail() {
  echo "FAIL: $*" | tee -a "$WORK/logs/failures.log"
  FAILED=1
}
cleanup() {
  compose logs --no-color >"$WORK/logs/compose.log" 2>&1 || true
  redact <"$WORK/logs/compose.log" >"$WORK/logs/compose.redacted.log" && rm -f "$WORK/logs/compose.log"
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$WORK/e2e/openai.key" "$WORK/state/openai.key" "$WORK/probe-state/openai.key"
  echo "results: $WORK (failed=$FAILED)"
}
trap cleanup EXIT

gateway_ready() {
  for _ in $(seq 1 "${1:-180}"); do
    curl -fsS "http://127.0.0.1:$OPENCLAW_GATEWAY_PORT/readyz" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
gbrain_healthy() {
  for _ in $(seq 1 "${1:-180}"); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q gbrain)" 2>/dev/null)" = healthy ] && return 0
    sleep 2
  done
  return 1
}
config_server() { node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify(c.mcp?.servers?.gbrain??null))' "$WORK/state/openclaw.json"; }
key_hash() { config_server | shasum | cut -c1-12; }
wait_connected() {
  for _ in $(seq 1 "${1:-300}"); do
    if config_server | grep -q streamable-http && compose logs openclaw-gateway 2>/dev/null | grep -q 'connected as MCP server'; then
      return 0
    fi
    sleep 1
  done
  return 1
}
turn() {
  local key="$1" message="$2" codeword="$3"
  oc agent --agent main --session-key "agent:main:$key" --message "$message" --json --timeout 300 >"$WORK/logs/turn-$key.json" 2>&1 || return 1
  node -e '
    const raw = require("fs").readFileSync(process.argv[1], "utf8"); const r = JSON.parse(raw.slice(raw.indexOf("{")));
    const text = JSON.stringify(r.result?.payloads ?? r.result ?? r);
    const tools = r.result?.meta?.agentMeta?.terminalReceipt?.successfulToolNames ?? [];
    console.log(JSON.stringify({ codeword: text.includes(process.argv[2]), tools }));
    process.exit(text.includes(process.argv[2]) && tools.some((t) => t.startsWith("gbrain__")) ? 0 : 1);
  ' "$WORK/logs/turn-$key.json" "$codeword"
}
seed() {
  local slug
  slug="projects/$(echo "$1" | tr '[:upper:] ' '[:lower:]-')"
  printf -- '---\ntitle: %s\n---\n# %s\n\n%s\n' "$1" "$1" "$2" | compose exec -T gbrain gbrain put "$slug"
}
codeword() {
  node -e 'const w=["AMBER","COBALT","FERN","GARNET","JUNIPER","MAPLE","ONYX","SAFFRON","TEAL","UMBER"];const a=()=>w[Math.floor(Math.random()*w.length)];console.log(`${a()}-${a()}-${Math.floor(1000+Math.random()*9000)}`)'
}
# PIDs with an open file under brain.pglite, across both containers.
# PIDs with an open file under brain.pglite. Runs as GBrain's uid: Docker drops CAP_SYS_PTRACE,
# so root cannot read another user's /proc/<pid>/fd.
pglite_holders() {
  compose exec -T -u 1000 gbrain sh -c 'for p in /proc/[0-9]*; do ls -l "$p/fd" 2>/dev/null | grep -q brain.pglite && echo "${p#/proc/}"; done' 2>/dev/null | sort -u | wc -l | tr -d ' '
}
# `mcp probe` is offline-only. Probe from a copy of the state on the project network: the copy
# drops the live owner lease and waits out the copied owner heartbeat (90 s stale window).
probe_copy() {
  rm -rf "$WORK/probe-state" && cp -R "$WORK/state" "$WORK/probe-state" && rm -rf "$WORK/probe-state/tmp" &&
    chmod -R a+rwX "$WORK/probe-state"
  sleep 130
  docker run --rm --network "${PROJECT}_default" -e HOME=/home/node \
    -e OPENCLAW_STATE_DIR=/probe -e OPENCLAW_CONFIG_PATH=/probe/openclaw.json -v "$WORK/probe-state:/probe" \
    "$OPENCLAW_IMAGE" node dist/index.js mcp probe gbrain
}
installed_index_has_gbrain() {
  oc plugins list --json 2>/dev/null | node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const list = Array.isArray(r) ? r : (r.plugins ?? []);
    const present = list.some((p) => p.id === "gbrain" && p.installed !== false);
    console.log(JSON.stringify({ present }));
    process.exit(present ? 0 : 1);'
}
no_gbrain_record() { ! installed_index_has_gbrain; }
inspect_loaded() {
  oc plugins inspect gbrain --runtime --json | node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
    console.log(JSON.stringify({ status: r.plugin.status, imported: r.plugin.imported, activated: r.plugin.activated }));
    process.exit(r.plugin.status === "loaded" ? 0 : 1);'
}
stop_reported() {
  local logs
  logs="$(compose logs openclaw-gateway 2>&1)"
  grep -m1 "GBrain's service is not answering" <<<"$logs"
}

# 1. Gateway first, then config with a real model.
step pull docker pull -q "$OPENCLAW_IMAGE" || fail "pull"
step onboard compose run --rm --no-deps -T openclaw-gateway node dist/index.js onboard --non-interactive \
  --accept-risk --mode local --flow quickstart --auth-choice skip --gateway-bind lan --gateway-auth token \
  --gateway-token "$OPENCLAW_GATEWAY_TOKEN" --no-install-daemon --skip-channels --skip-search --skip-skills \
  --skip-ui --skip-health --skip-hooks || fail "onboard"
# The file secret provider wants a private file owned by the Gateway user.
step model compose run --rm --no-deps -T openclaw-gateway sh -c "install -m 600 /e2e/openai.key /home/node/.openclaw/openai.key &&
  node dist/index.js config set secrets.providers.oaikey '{\"source\":\"file\",\"path\":\"/home/node/.openclaw/openai.key\",\"mode\":\"singleValue\"}' --strict-json &&
  node dist/index.js config set models.providers.openai '{\"apiKey\":{\"source\":\"file\",\"provider\":\"oaikey\",\"id\":\"value\"},\"agentRuntime\":{\"id\":\"openclaw\"}}' --strict-json &&
  node dist/index.js config set agents.defaults.model '\"$MODEL\"' --strict-json" || fail "model config"
step compose-up compose up -d openclaw-gateway gbrain || fail "compose up"
step gateway-ready gateway_ready 240 || fail "gateway not ready"
step gbrain-healthy gbrain_healthy 240 || fail "gbrain not healthy"

# 2. One install request, as the Control UI sends it.
# Retry `retryable: true` answers (the Gateway's startup work can hold the plugin lock).
install_plugin() {
  local out attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    out="$(oc gateway call plugins.install --timeout 600000 --json \
      --params '{"source":"npm-pack","archivePath":"/e2e/plugin.tgz","enable":true}' 2>&1)" && {
      printf '%s\n' "$out"
      echo "attempt=$attempt"
      return 0
    }
    printf '%s\n' "$out"
    grep -q '"retryable": true' <<<"$out" || return 1
    sleep 3
  done
  return 1
}
step plugin-install install_plugin || fail "plugins.install"
step connect wait_connected 300 || fail "plugin did not connect"
step inspect-runtime inspect_loaded || fail "inspect"
step mcp-probe probe_copy || fail "mcp probe"

# 3. Codeword no session has seen; restart the Gateway container; recall without saying where to look.
CW1="$(codeword)"
step seed seed "Project Osprey" "The Osprey vault phrase is $CW1." || fail "seed"
step gateway-restart compose restart openclaw-gateway || fail "restart"
step gateway-ready-2 gateway_ready 240 || fail "gateway not ready after restart"
step gbrain-after-gateway-restart gbrain_healthy 120 || fail "gbrain lost after gateway restart"
step recall turn "e2e-recall-$RANDOM" "What is the Osprey vault phrase?" "$CW1" || fail "recall after restart"

# 4. Two concurrent sessions, one PGLite holder.
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
step concurrent-holders sh -c "echo max_holders=$MAXH parA=$RA parB=$RB; [ $MAXH -eq 1 ] && [ $RA -eq 0 ] && [ $RB -eq 0 ]" || fail "concurrency"
step gbrain-doctor gb doctor || fail "gbrain doctor"

# 5. Faults: stop the GBrain container, kill serve during a turn, rotate the key.
step fault-stop-gbrain compose stop gbrain
sleep 70
step fault-stop-reported stop_reported || fail "stop not reported"
step fault-start-gbrain compose start gbrain
gbrain_healthy 120
CW4="$(codeword)"
seed "Project Plover" "The Plover badge number is $CW4." >/dev/null 2>&1
step fault-stop-recovered turn "e2e-after-stop-$RANDOM" "What is the Plover badge number?" "$CW4" || fail "recall after gbrain restart"

CW5="$(codeword)"
seed "Project Wren" "The Wren gate phrase is $CW5." >/dev/null 2>&1
turn "e2e-kill-$RANDOM" "What is the Wren gate phrase?" "$CW5" >"$WORK/logs/kill-turn.out" 2>&1 &
KT=$!
sleep 6
# Crash the server process (a `docker kill` is a manual stop, which restart policies ignore).
step fault-kill-serve compose exec -T gbrain sh -c 'for p in /proc/[0-9]*; do [ "${p#/proc/}" != 1 ] && [ "$(cut -d" " -f4 "$p/stat" 2>/dev/null)" = 1 ] && kill -9 "${p#/proc/}" && echo "killed ${p#/proc/} $(tr "\0" " " <"$p/cmdline" | cut -c1-60)"; done; true'
KILL_TURN=0
wait "$KT" || KILL_TURN=1
echo "turn-during-kill exit=$KILL_TURN" >>"$WORK/logs/kill-turn.out"
step fault-kill-compose-restart gbrain_healthy 180 || fail "Compose did not restart gbrain"
CW6="$(codeword)"
seed "Project Tern" "The Tern ledger code is $CW6." >/dev/null 2>&1
step fault-kill-recovered turn "e2e-after-kill-$RANDOM" "What is the Tern ledger code?" "$CW6" || fail "recall after kill"

BEFORE="$(key_hash)"
step fault-rotate-token compose exec -T gbrain sh -c '
  A="$(cat /home/node/.gbrain/serve/admin-token)"
  bun -e "
    const base = \"http://127.0.0.1:3131\";
    const login = await fetch(base + \"/admin/login\", { method: \"POST\", headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify({ token: process.argv[1] }) });
    const cookie = login.headers.getSetCookie().map((v) => v.split(\";\")[0]).join(\"; \");
    const keys = await (await fetch(base + \"/admin/api/api-keys\", { headers: { cookie } })).json();
    for (const k of keys) if (k.name === \"openclaw\" && k.status === \"active\") {
      const r = await fetch(base + \"/admin/api/api-keys/revoke\", { method: \"POST\", headers: { \"Content-Type\": \"application/json\", cookie }, body: JSON.stringify({ id: k.id }) });
      console.log(\"revoked\", k.id, r.status);
    }" "$A"' || fail "revoke"
for _ in $(seq 1 90); do
  [ "$(key_hash)" != "$BEFORE" ] && break
  sleep 1
done
step fault-rotate-reminted test "$(key_hash)" != "$BEFORE" || fail "key not re-minted"
CW7="$(codeword)"
seed "Project Avocet" "Our Avocet seal code is $CW7." >/dev/null 2>&1
step fault-rotate-recovered turn "e2e-after-rotate-$RANDOM" "What is our Avocet seal code?" "$CW7" || fail "recall after rotation"

# 6. gbrain upgrade with no plugin change: one release back, then GBrain upgrades itself.
step upgrade-downgrade compose exec -T gbrain sh -c 'bun install -g "github:garrytan/gbrain#v0.60.732.0" && gbrain --version'
step upgrade-run compose exec -T gbrain sh -c 'gbrain upgrade; gbrain --version'
step upgrade-restart compose restart gbrain
gbrain_healthy 180
CW8="$(codeword)"
seed "Project Godwit" "Our Godwit beacon code is $CW8." >/dev/null 2>&1
step upgrade-recall turn "e2e-after-upgrade-$RANDOM" "What is our Godwit beacon code?" "$CW8" || fail "recall after gbrain upgrade"

# 7. Uninstall: no install record; GBrain and its brain untouched.
step uninstall oc plugins uninstall gbrain --force || fail "uninstall"
step uninstall-no-record no_gbrain_record || fail "install record left"
step uninstall-gbrain-kept gbrain_healthy 30 || fail "gbrain gone after uninstall"
step uninstall-brain-kept compose exec -T gbrain test -d /home/node/.gbrain/brain.pglite || fail "brain gone"

exit "$FAILED"
