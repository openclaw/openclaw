#!/usr/bin/env bash
# Sourced by run.sh; the parent owns traps, cleanup, and phase markers.

git_release_cli() {
  local root="${git_release_root:-$git_checkout}"
  if [ -n "${git_release_root:-}" ]; then
    :
  elif [ -L "$OPENCLAW_STATE_DIR/git-install/openclaw" ]; then
    root="$OPENCLAW_STATE_DIR/git-install/openclaw"
  elif [ -L "$OPENCLAW_STATE_DIR/git-install/lib/node_modules/openclaw" ]; then
    root="$OPENCLAW_STATE_DIR/git-install/lib/node_modules/openclaw"
  fi
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" env -u OPENCLAW_LAUNCHD_LABEL \
    -u OPENCLAW_PROFILE -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH \
    -u OPENCLAW_GATEWAY_PORT -u OPENCLAW_SYSTEMD_UNIT -u OPENCLAW_GATEWAY_SERVICE_PID \
    OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR" OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG_PATH" \
    node "$root/${git_release_entry:-openclaw.mjs}" "$@"
}

git_release_checkout() {
  # The upstream stands in for GitHub: the checkout's main tracks its main, and
  # moving that branch is what makes the next Dev update see a new commit.
  # Read-only object sharing avoids copying the host's unrelated history. All
  # refs, index, worktrees, installs, and builds belong to this Linux container.
  git init --bare "$git_upstream"
  printf '%s\n' /tmp/openclaw-source.git/objects >"$git_upstream/objects/info/alternates"
  git -C "$git_upstream" update-ref refs/heads/main "$OPENCLAW_UPGRADE_SURVIVOR_GIT_BASELINE_SHA"
  git init "$git_checkout"
  printf '%s\n' /tmp/openclaw-source.git/objects >"$git_checkout/.git/objects/info/alternates"
  git -C "$git_checkout" config user.name 'Upgrade survivor'
  git -C "$git_checkout" config user.email 'upgrade-survivor@example.invalid'
  git -C "$git_checkout" remote add origin "$git_upstream"
  git -C "$git_checkout" fetch origin
  git -C "$git_checkout" checkout -b main --track origin/main
  git -C "$git_checkout" cat-file -e "$CANDIDATE_SPEC^{commit}"
  candidate_version="$(git -C "$git_checkout" show "$CANDIDATE_SPEC:package.json" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).version))')"
}

git_release_build_baseline() (
  cd "$git_checkout"
  corepack pnpm install --frozen-lockfile
  corepack pnpm build
  corepack pnpm ui:build
) >"$ARTIFACT_ROOT/git-baseline-build.log" 2>&1

git_release_install_service() {
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG="$SYSTEMCTL_SHIM_LOG"
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE="$SYSTEMCTL_SHIM_PID_FILE"
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG="$SYSTEMCTL_SHIM_DAEMON_LOG"
  install_update_restart_systemctl_shim absent
  node - "$OPENCLAW_CONFIG_PATH" "$GATEWAY_LOG" <<'NODE'
const fs = require('node:fs');
fs.mkdirSync(require('node:path').dirname(process.argv[2]), { recursive: true });
fs.writeFileSync(process.argv[2], JSON.stringify({
  gateway: { mode: 'local', port: 18789, bind: 'loopback', auth: { mode: 'token', token: 'upgrade-survivor-token' } },
  logging: { level: 'debug', file: process.argv[3] },
  tools: { profile: 'full', web: { search: { provider: 'duckduckgo' } } },
  plugins: { allow: ['deepseek', 'duckduckgo'] },
}));
NODE
  git_release_cli gateway install --force --json >"$BASELINE_SERVICE_INSTALL_JSON" 2>"$BASELINE_SERVICE_INSTALL_ERR"
  systemctl --user start openclaw-gateway.service
  git_release_ready
  grep -F "$git_checkout" "$HOME/.config/systemd/user/openclaw-gateway.service"
}

git_release_ready() {
  local attempt
  for attempt in $(seq 1 300); do
    if node -e 'fetch("http://127.0.0.1:18789/readyz").then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))' >"$ARTIFACT_ROOT/git-readyz.json"; then
      return 0
    fi
    sleep 1
  done
  cat "$SYSTEMCTL_SHIM_DAEMON_LOG" >&2
  return 1
}

git_release_strip_error='ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING|Stripping types'

# Gateway output after the last mark: the configured log file and the service's
# stdout, which holds startup failures before file logging is ready.
git_release_mark() {
  git_log_start="$(wc -c <"$GATEWAY_LOG")"
  git_daemon_start="$(wc -c <"$SYSTEMCTL_SHIM_DAEMON_LOG")"
}

git_release_slice() {
  tail -c +"$((git_log_start + 1))" "$GATEWAY_LOG" >"$ARTIFACT_ROOT/$1-gateway.log"
  tail -c +"$((git_daemon_start + 1))" "$SYSTEMCTL_SHIM_DAEMON_LOG" >>"$ARTIFACT_ROOT/$1-gateway.log"
}

# On the old layout the Gateway fails at startup loading the configured web
# search provider's contract; record which outcome the service reached.
git_release_settle() {
  local label="$1" attempt
  for attempt in $(seq 1 180); do
    if node -e 'fetch("http://127.0.0.1:18789/readyz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; then
      echo ready | tee "$ARTIFACT_ROOT/$label-settled.txt"
      return 0
    fi
    git_release_slice "$label"
    if grep -qE "$git_release_strip_error" "$ARTIFACT_ROOT/$label-gateway.log"; then
      echo startup-failed | tee "$ARTIFACT_ROOT/$label-settled.txt"
      return 0
    fi
    sleep 1
  done
  echo timeout | tee "$ARTIFACT_ROOT/$label-settled.txt"
}

git_release_update() {
  local label="$1" target="$2" result=0 previous_pid previous_lines
  git_release_mark
  git_release_cli --version >"$ARTIFACT_ROOT/$label-driver.txt"
  previous_pid="$(cat "$SYSTEMCTL_SHIM_PID_FILE")"
  previous_lines="$(wc -l <"$SYSTEMCTL_SHIM_LOG")"
  git -C "$git_upstream" update-ref refs/heads/main "$target"
  git_release_cli update --channel dev --yes --json \
    >"$ARTIFACT_ROOT/$label-update.json" 2>"$ARTIFACT_ROOT/$label-update.err" || result=$?
  printf '%s\n' "$result" >"$ARTIFACT_ROOT/$label-update.exit"
  tail -n +"$((previous_lines + 1))" "$SYSTEMCTL_SHIM_LOG" >"$ARTIFACT_ROOT/$label-systemctl.log"
  cat "$HOME/.config/systemd/user/openclaw-gateway.service" >"$ARTIFACT_ROOT/$label-service.txt"
  case "$label" in
    baseline)
      # 7db69bedeab6 converts the checkout but reports the checkout's service as
      # foreign and leaves it untouched; git_release_adopt_launcher moves it.
      [ "$result" -eq 0 ]
      ;;
    first-hop*)
      # 7db69bedeab6 drives this hop while its Gateway cannot start; record the outcome.
      git_release_settle "$label"
      ;;
    *)
      if [ "$result" -ne 0 ]; then
        cat "$ARTIFACT_ROOT/$label-update.json" "$ARTIFACT_ROOT/$label-update.err" >&2
        return "$result"
      fi
      assert_update_restart_service_replaced "$previous_pid" "$previous_lines"
      grep -F 'openclaw-launcher.mjs' "$HOME/.config/systemd/user/openclaw-gateway.service"
      git_release_ready
      # Evidence of the switch window, then a fresh mark: an old-layout Gateway
      # restarted before the link moved may still log the stripping error here.
      git_release_slice "$label-update"
      git_release_mark
      ;;
  esac
}

# Reaches the reporter's state: the service starts the release launcher. The
# baseline CLI reinstalls the service through the release link's dist entry;
# 7db69bedeab6 names the launcher only for that entrypoint, not openclaw.mjs.
git_release_adopt_launcher() {
  local previous_pid
  git_release_mark
  previous_pid="$(cat "$SYSTEMCTL_SHIM_PID_FILE")"
  git_release_entry=dist/index.js git_release_cli gateway install --force --json \
    >"$ARTIFACT_ROOT/baseline-launcher-install.json" 2>"$ARTIFACT_ROOT/baseline-launcher-install.err"
  cat "$HOME/.config/systemd/user/openclaw-gateway.service" | tee "$ARTIFACT_ROOT/baseline-launcher-service.txt"
  grep -F "$OPENCLAW_STATE_DIR/git-install/openclaw-launcher.mjs" "$HOME/.config/systemd/user/openclaw-gateway.service"
  if [ "$(cat "$SYSTEMCTL_SHIM_PID_FILE")" = "$previous_pid" ]; then
    systemctl --user restart openclaw-gateway.service
  fi
  git_release_settle baseline
}

git_release_assert_layout() {
  local expected="$1" sha="$2" target
  if [ "$expected" = old ]; then
    target="$(realpath "$OPENCLAW_STATE_DIR/git-install/lib/node_modules/openclaw")"
    [[ "$target" == */git-install/releases/*/lib/node_modules/openclaw ]]
  else
    target="$(realpath "$OPENCLAW_STATE_DIR/git-install/openclaw")"
    [[ "$target" == */git-install/releases/*/openclaw && "$target" != */node_modules/* ]]
    [ ! -e "$OPENCLAW_STATE_DIR/git-install/lib/node_modules/openclaw" ]
    [ ! -L "$OPENCLAW_STATE_DIR/git-install/lib/node_modules/openclaw" ]
  fi
  printf '%s\n' "$target" | tee "$ARTIFACT_ROOT/$CURRENT_PHASE-layout.txt"
  git -C "$target" rev-parse HEAD | tee "$ARTIFACT_ROOT/$CURRENT_PHASE-sha.txt"
  git -C "$git_checkout" rev-parse HEAD | tee "$ARTIFACT_ROOT/$CURRENT_PHASE-checkout-sha.txt"
  [ -z "$sha" ] || [ "$(git -C "$target" rev-parse HEAD)" = "$sha" ]
}

# The second hop must run the candidate's updater: from the release when the
# first hop advanced it, otherwise from the checkout it advanced in place.
git_release_second_hop() {
  local slot="$OPENCLAW_STATE_DIR/git-install/lib/node_modules/openclaw"
  if [ "$(git -C "$slot" rev-parse HEAD)" = "$CANDIDATE_SPEC" ]; then
    git_release_update second-hop "$CANDIDATE_SPEC"
  else
    [ "$(git -C "$git_checkout" rev-parse HEAD)" = "$CANDIDATE_SPEC" ]
    git_release_root="$git_checkout" git_release_update second-hop "$CANDIDATE_SPEC"
  fi
}

git_release_request() {
  local label="$1" expected="$2" result=0
  git_release_cli gateway call tools.invoke \
    --url ws://127.0.0.1:18789 --token upgrade-survivor-token \
    --params '{"name":"web_search","args":{"query":"upgrade survivor"}}' \
    --timeout 60000 --json >"$ARTIFACT_ROOT/$label-request.json" 2>"$ARTIFACT_ROOT/$label-request.err" || result=$?
  printf '%s\n' "$result" >"$ARTIFACT_ROOT/$label-request.exit"
  # The slice starts at the hop's mark, so it covers the restart and the request.
  git_release_slice "$label"
  if [ "$expected" = fail ]; then
    grep -E "$git_release_strip_error" "$ARTIFACT_ROOT/$label-gateway.log" | grep -F 'web-search-contract-api' | head -n 3
    if [ "$result" -eq 0 ]; then
      node -e 'const r=require(process.argv[1]);if(r.ok!==false)throw Error("Expected failed invocation")' "$ARTIFACT_ROOT/$label-request.json"
    fi
  else
    [ "$result" -eq 0 ]
    node -e 'const r=require(process.argv[1]);if(r.ok!==true||r.toolName!=="web_search")throw Error(JSON.stringify(r));console.log("web_search construction and invocation succeeded: "+JSON.stringify(r).slice(0,400))' "$ARTIFACT_ROOT/$label-request.json"
    ! grep -E "$git_release_strip_error" "$ARTIFACT_ROOT/$label-gateway.log"
  fi
}

run_git_release_survivor() {
  normalize_baseline
  [ "$baseline_spec" = openclaw@2026.11.5 ] && [ "$CANDIDATE_KIND" = git ]
  local baseline_sha="$OPENCLAW_UPGRADE_SURVIVOR_GIT_BASELINE_SHA"
  phase git-initialize-state initialize_state
  unset OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY DISCORD_BOT_TOKEN TELEGRAM_BOT_TOKEN
  git_checkout="$RUNTIME_ROOT/git-checkout"
  git_upstream="$RUNTIME_ROOT/git-upstream.git"
  candidate_install_mode=git
  phase git-checkout-baseline git_release_checkout
  phase git-build-baseline git_release_build_baseline
  phase git-install-service git_release_install_service
  phase git-baseline-convert git_release_update baseline "$baseline_sha"
  phase git-baseline-layout git_release_assert_layout old "$baseline_sha"
  phase git-baseline-adopt-launcher git_release_adopt_launcher
  phase git-baseline-reproduce git_release_request baseline fail
  # The release's own CLI is the reporter's `openclaw`; record whether 7db69bedeab6
  # can update from inside node_modules, then drive the hop from the checkout.
  phase git-first-hop-release-cli git_release_update first-hop-release-cli "$CANDIDATE_SPEC"
  git_release_root="$git_checkout" phase git-candidate-first-hop git_release_update first-hop "$CANDIDATE_SPEC"
  phase git-first-hop-layout git_release_assert_layout old ""
  phase git-first-hop-observe git_release_request first-hop fail
  phase git-candidate-second-hop git_release_second_hop
  phase git-second-hop-layout git_release_assert_layout new "$CANDIDATE_SPEC"
  phase git-second-hop-request git_release_request second-hop pass
  installed_version="$candidate_version"
  echo "Git release survivor passed: 7db69bedeab6 converted to the old layout and drove the first hop; the candidate updater moved the release outside node_modules and web_search succeeded."
}
