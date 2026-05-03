#!/usr/bin/env bash
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh

openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
openclaw_e2e_install_package /tmp/openclaw-plugin-lifecycle-install.log "mounted OpenClaw package" /tmp/npm-prefix

package_root="$(openclaw_e2e_package_root /tmp/npm-prefix)"
entry="$(openclaw_e2e_package_entrypoint "$package_root")"
export PATH="/tmp/npm-prefix/bin:$PATH"
export npm_config_loglevel=error
export npm_config_fund=false
export npm_config_audit=false

source scripts/e2e/lib/plugins/fixtures.sh

plugin_id="lifecycle-claw"
package_name="@openclaw/lifecycle-claw"
probe="scripts/e2e/lib/plugin-lifecycle-matrix/probe.mjs"
resource_dir="/tmp/openclaw-plugin-lifecycle-matrix"
mkdir -p "$resource_dir"
summary_tsv="$resource_dir/resource-summary.tsv"
printf "phase\tmax_rss_kb\tuser_seconds\tsystem_seconds\telapsed\n" >"$summary_tsv"

if [[ ! -x /usr/bin/time ]]; then
  echo "Missing /usr/bin/time; cannot collect plugin lifecycle RSS/CPU metrics." >&2
  exit 1
fi

run_measured() {
  local phase="$1"
  shift
  local stdout_log="$resource_dir/${phase}.stdout.log"
  local stderr_log="$resource_dir/${phase}.stderr.log"
  local time_log="$resource_dir/${phase}.time.log"

  echo "Running plugin lifecycle phase: $phase"
  set +e
  /usr/bin/time -v -o "$time_log" "$@" >"$stdout_log" 2>"$stderr_log"
  local status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    echo "Plugin lifecycle phase failed: $phase (status $status)" >&2
    echo "--- stdout: $phase ---" >&2
    cat "$stdout_log" >&2 || true
    echo "--- stderr: $phase ---" >&2
    cat "$stderr_log" >&2 || true
    echo "--- resource: $phase ---" >&2
    cat "$time_log" >&2 || true
    exit "$status"
  fi

  local max_rss_kb user_seconds system_seconds elapsed
  max_rss_kb="$(awk -F: '/Maximum resident set size/ { gsub(/^[ \t]+/, "", $2); print $2 }' "$time_log")"
  user_seconds="$(awk -F: '/User time/ { gsub(/^[ \t]+/, "", $2); print $2 }' "$time_log")"
  system_seconds="$(awk -F: '/System time/ { gsub(/^[ \t]+/, "", $2); print $2 }' "$time_log")"
  elapsed="$(awk -F: '/Elapsed \(wall clock\) time/ { gsub(/^[ \t]+/, "", $2); print $2 }' "$time_log")"
  if [[ -z "$max_rss_kb" || -z "$user_seconds" || -z "$system_seconds" || -z "$elapsed" ]]; then
    echo "Could not parse resource metrics for $phase" >&2
    cat "$time_log" >&2
    exit 1
  fi
  printf "%s\t%s\t%s\t%s\t%s\n" "$phase" "$max_rss_kb" "$user_seconds" "$system_seconds" "$elapsed" >>"$summary_tsv"
  echo "plugin lifecycle resource: phase=$phase max_rss_kb=$max_rss_kb user_s=$user_seconds system_s=$system_seconds elapsed=$elapsed"
}

pack_root="$(mktemp -d "/tmp/openclaw-plugin-lifecycle-pack.XXXXXX")"
registry_root="$(mktemp -d "/tmp/openclaw-plugin-lifecycle-registry.XXXXXX")"
pack_fixture_plugin "$pack_root/v1" /tmp/lifecycle-claw-1.0.0.tgz "$plugin_id" 1.0.0 lifecycle.v1 "Lifecycle Claw"
pack_fixture_plugin "$pack_root/v2" /tmp/lifecycle-claw-2.0.0.tgz "$plugin_id" 2.0.0 lifecycle.v2 "Lifecycle Claw"
start_npm_fixture_registry "$package_name" 1.0.0 /tmp/lifecycle-claw-1.0.0.tgz "$registry_root" "$package_name" 2.0.0 /tmp/lifecycle-claw-2.0.0.tgz

run_measured install-v1 node "$entry" plugins install "npm:$package_name@1.0.0"
node "$probe" assert-version "$plugin_id" 1.0.0

run_measured inspect-v1 node "$entry" plugins inspect "$plugin_id" --runtime --json

run_measured disable node "$entry" plugins disable "$plugin_id"
node "$probe" assert-enabled "$plugin_id" false

run_measured enable node "$entry" plugins enable "$plugin_id"
node "$probe" assert-enabled "$plugin_id" true

run_measured upgrade-v2 node "$entry" plugins update "$package_name@2.0.0"
node "$probe" assert-version "$plugin_id" 2.0.0

run_measured downgrade-v1 node "$entry" plugins update "$package_name@1.0.0"
node "$probe" assert-version "$plugin_id" 1.0.0

install_path="$(node "$probe" install-path "$plugin_id")"
rm -rf "$install_path"
if [[ -e "$install_path" ]]; then
  echo "Failed to remove plugin code before missing-code uninstall: $install_path" >&2
  exit 1
fi

run_measured missing-code-uninstall node "$entry" plugins uninstall "$plugin_id" --force
node "$probe" assert-uninstalled "$plugin_id"

echo "Plugin lifecycle resource summary:"
cat "$summary_tsv"
echo "Plugin lifecycle matrix passed."
