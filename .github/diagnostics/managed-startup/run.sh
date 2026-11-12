#!/usr/bin/env bash
set -euo pipefail
# This file is an unexecuted CI-only template, never a local diagnostic.
[[ "$GITHUB_ACTIONS" == true && "$RUNNER_ENVIRONMENT" == github-hosted ]] || { echo 'Requires disposable GitHub-hosted Linux runner'; exit 1; }
package=$(realpath "$1")
output=$(realpath -m "$2")
scripts=$(cd "$(dirname "$0")" && pwd)
node=$(command -v node)
[[ "$("$node" -p process.version)" == v24.22.1 ]]
[[ $package != *' '* && $scripts != *' '* && $output != *' '* ]]
unit="openclaw-profile-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.service"
base="$HOME/.config/systemd/user/$unit"
drop="$base.d"
private=$(mktemp -d "$RUNNER_TEMP/managed-allocation.XXXXXXXX")
mkdir -p "$output" "$private/home" "$private/state" "$private/tools"
chmod 700 "$private" "$private/home" "$private/state" "$private/tools" "$output"
# No existing label, service, drop-in, or previous attempt may be adopted.
[[ ! -e $base && ! -e $drop && ! -e $base.bak ]]
[[ "$(systemctl --user show "$unit" -p LoadState --value)" == not-found ]]
collector=''
cleanup() {
  code=$?
  trap - EXIT INT TERM
  if [[ -n $collector ]]; then kill "$collector" 2>/dev/null || true; wait "$collector" 2>/dev/null || true; fi
  cleanup_ok=true
  if [[ "$(systemctl --user show "$unit" -p LoadState --value)" != not-found ]]; then
    timeout 100 systemctl --user stop "$unit" >/dev/null 2>&1 || cleanup_ok=false
    systemctl --user disable "$unit" >/dev/null 2>&1 || true
    if [[ "$(systemctl --user show "$unit" -p MainPID --value)" != 0 ]]; then cleanup_ok=false; fi
  fi
  if [[ $cleanup_ok == true ]]; then
    rm -f -- "$base" "$base.bak" "$drop/90-allocation.conf"
    rmdir -- "$drop" 2>/dev/null || true
    systemctl --user daemon-reload
    rm -rf -- "$private"
  else
    echo '::error::Owned service cleanup incomplete; do not interpret capture as complete'
    code=1
  fi
  printf '{"unit":"%s","stopped":%s}\n' "$unit" "$cleanup_ok" > "$output/cleanup.json"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
cp "$scripts/preload.cjs" "$scripts/launch.py" "$private/tools/"
export DIAG_PRIVATE="$private" DIAG_OUTPUT="$output" DIAG_PACKAGE="$package" DIAG_NODE="$node" DIAG_UNIT="$unit"
"$node" --input-type=module - <<'NODE'
import fs from 'node:fs';
const e=process.env, root=e.DIAG_PRIVATE, out=e.DIAG_OUTPUT;
const pkg=JSON.parse(fs.readFileSync(e.DIAG_PACKAGE+'/package.json'));
const info=JSON.parse(fs.readFileSync(e.DIAG_PACKAGE+'/dist/build-info.json'));
if(pkg.version!=='2026.11.4' || info.commit!=='a233af0b84e093845c62e88c2702cbd9b297f22c') throw Error('wrong package identity');
fs.writeFileSync(root+'/state/openclaw.json', JSON.stringify({gateway:{mode:'local',bind:'loopback',auth:{mode:'token',token:'isolated-ci-diagnostic-not-a-live-credential'}}}));
fs.writeFileSync(root+'/tools/profile-config.json',JSON.stringify({candidate:info.commit, output:out, ready:out+'/ready.json',
  hardEndAt:Date.now()+120000, node:e.DIAG_NODE, package:e.DIAG_PACKAGE, port:19789, unit:e.DIAG_UNIT, home:root+'/home'}));
fs.writeFileSync(out+'/package-identity.json',JSON.stringify({packageVersion:pkg.version,buildInfo:info},null,2));
NODE
# Refuse a preexisting listener. No port-owner termination.
"$node" --input-type=module - <<'NODE'
import net from 'node:net';
const server=net.createServer();
server.on('error',()=>process.exit(1));
server.listen(19789,'127.0.0.1',()=>server.close());
NODE
mkdir -p "$drop"
# Preserve native base argv/autoheap; modify only this task's effective ExecStart.
printf '[Service]\nExecStart=\nExecStart=/usr/bin/python3 %s %s %s\n' \
  "$private/tools/launch.py" "$base" "$private/tools/profile-config.json" > "$drop/90-allocation.conf"
"$node" "$scripts/capture.mjs" "$private/tools/profile-config.json" &
collector=$!
# HOME is native service account home only for installation. Explicit paths isolate config/state.
# The wrapper replaces runtime HOME with the private empty home before loading package code.
set +e
timeout --signal=TERM --kill-after=10s 150 env -i HOME="$HOME" USER="$(id -un)" LOGNAME="$(id -un)" PATH="$PATH" \
  XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
  OPENCLAW_STATE_DIR="$private/state" OPENCLAW_CONFIG_PATH="$private/state/openclaw.json" \
  OPENCLAW_SYSTEMD_UNIT="$unit" NODE_OPTIONS='' \
  "$node" "$package/openclaw.mjs" gateway install --runtime node --runtime-path "$node" --port 19789 --json \
  > "$private/install.log" 2>&1
install_status=$?
set -e
if [[ $install_status != 0 ]]; then
  printf '{"status":"incomplete","stage":"native-service-install","exitCode":%s}\n' "$install_status" > "$output/blocker.json"
  # Only a fixed synthetic token was supplied; still suppress its literal value.
  sed 's/isolated-ci-diagnostic-not-a-live-credential/[synthetic-token]/g' "$private/install.log" > "$output/install-error.txt"
  exit "$install_status"
fi
wait "$collector"
collector=''
# Only generated unit has synthetic config. Do not upload config, env files or raw journal.
grep -v -E '^(Environment|EnvironmentFile)=' "$base" > "$output/native-unit.txt"
cp "$drop/90-allocation.conf" "$output/task-drop-in.txt"
