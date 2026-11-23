#!/usr/bin/env bash
# Sourced by run.sh; the parent owns traps, cleanup, and phase markers.
#
# Routes (OPENCLAW_UPGRADE_SURVIVOR_GIT_ROUTE):
# - baseline (default): a checkout of OPENCLAW_UPGRADE_SURVIVOR_GIT_BASELINE_SHA with a
#   service reaches the candidate by the baseline's own updater, then the candidate's
#   updater runs every remaining update.
# - no-service: a checkout of the candidate with no service updates through a release.
# - package-to-git: a package with a service switches to the Git checkout. With the
#   candidate's own package (OPENCLAW_UPGRADE_SURVIVOR_GIT_PACKAGE_SPEC=current), its
#   updater runs the switch: the first switch targets a crash commit and must fall back to
#   the npm package, then the retried switch succeeds. A published package's updater runs
#   the switch with its own code; its result is recorded.

git_release_lib="$PWD/scripts/e2e/lib/upgrade-survivor"
git_release_helper="$git_release_lib/git-release.mjs"
git_release_switch_back='failed to start twice; switched back'
git_release_crash_line='upgrade-survivor: crash release exits before listening'

git_release_init() {
  git_prefix="$OPENCLAW_STATE_DIR/git-install"
  git_release_env=(env -u OPENCLAW_LAUNCHD_LABEL -u OPENCLAW_PROFILE -u OPENCLAW_STATE_DIR
    -u OPENCLAW_CONFIG_PATH -u OPENCLAW_GATEWAY_PORT -u OPENCLAW_SYSTEMD_UNIT
    -u OPENCLAW_GATEWAY_SERVICE_PID
    OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR" OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG_PATH")
  git_release_good_tip="$CANDIDATE_SPEC"
  touch "$GATEWAY_LOG" "$SYSTEMCTL_SHIM_DAEMON_LOG" "$SYSTEMCTL_SHIM_LOG"
  git_release_mark
}

# The CLI of `git_release_root`, else the release link, the earlier lib/node_modules link,
# the checkout, or (package route, before any checkout) `openclaw` on PATH.
git_release_cli() {
  local root="${git_release_root:-$git_checkout}"
  if [ -n "${git_release_root:-}" ]; then
    :
  elif [ -L "$git_prefix/openclaw" ]; then
    root="$git_prefix/openclaw"
  elif [ -L "$git_prefix/lib/node_modules/openclaw" ]; then
    root="$git_prefix/lib/node_modules/openclaw"
  fi
  if [ ! -e "$root/${git_release_entry:-openclaw.mjs}" ]; then
    git_release_path_cli "$@"
    return
  fi
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" "${git_release_env[@]}" \
    node "$root/${git_release_entry:-openclaw.mjs}" "$@"
}

# `openclaw` as PATH resolves it, for the package route.
git_release_path_cli() {
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" "${git_release_env[@]}" \
    ${OPENCLAW_GIT_DIR:+OPENCLAW_GIT_DIR="$OPENCLAW_GIT_DIR"} openclaw "$@"
}

git_release_checkout() {
  local start="$1" base
  # The upstream stands in for GitHub: the checkout's main tracks its main, and
  # moving that branch is what makes the next Dev update see a new commit.
  # Read-only object sharing avoids copying the host's unrelated history. All
  # refs, index, worktrees, installs, and builds belong to this Linux container.
  git init --bare "$git_upstream"
  printf '%s\n' /tmp/openclaw-source.git/objects >"$git_upstream/objects/info/alternates"
  git -C "$git_upstream" update-ref refs/heads/main "$start"
  git init "$git_checkout"
  printf '%s\n' /tmp/openclaw-source.git/objects >"$git_checkout/.git/objects/info/alternates"
  git -C "$git_checkout" config user.name 'Upgrade survivor'
  git -C "$git_checkout" config user.email 'upgrade-survivor@example.invalid'
  git -C "$git_checkout" remote add origin "$git_upstream"
  git -C "$git_checkout" fetch origin
  git -C "$git_checkout" checkout -b main --track origin/main
  git -C "$git_checkout" cat-file -e "$CANDIDATE_SPEC^{commit}"
  # A baseline off the candidate's history (a release tag, a newer main) is checked out
  # detached with local main at the shared base, so no update replays baseline-only
  # commits onto the candidate.
  base="$(git -C "$git_checkout" merge-base "$start" "$CANDIDATE_SPEC")"
  if [ "$base" != "$start" ]; then
    git -C "$git_checkout" checkout --detach "$start"
    git -C "$git_checkout" branch -f main "$base"
  fi
  {
    echo "start $start"
    echo "local-main $(git -C "$git_checkout" rev-parse main)"
    echo "head $(git -C "$git_checkout" rev-parse HEAD) $(git -C "$git_checkout" symbolic-ref -q HEAD || echo detached)"
  } | tee "$ARTIFACT_ROOT/git-checkout.txt"
  candidate_version="$(git -C "$git_checkout" show "$CANDIDATE_SPEC:package.json" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).version))')"
}

git_release_build_checkout() (
  cd "$git_checkout"
  corepack pnpm install --frozen-lockfile
  corepack pnpm build
  corepack pnpm ui:build
) >"$ARTIFACT_ROOT/git-baseline-build.log" 2>&1

git_release_write_config() {
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
}

git_release_unit() {
  printf '%s\n' "$HOME/.config/systemd/user/openclaw-gateway.service"
}

git_release_install_service() {
  local cli="${1:-git_release_cli}"
  git_release_write_config
  "$cli" gateway install --force --json >"$BASELINE_SERVICE_INSTALL_JSON" 2>"$BASELINE_SERVICE_INSTALL_ERR"
  systemctl --user start openclaw-gateway.service
  git_release_ready
  grep -F 'ExecStart' "$(git_release_unit)" | tee "$ARTIFACT_ROOT/baseline-service-execstart.txt"
}

git_release_readyz() {
  node -e 'fetch("http://127.0.0.1:18789/readyz").then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))'
}

git_release_ready() {
  local attempt
  for attempt in $(seq 1 300); do
    if git_release_readyz >"$ARTIFACT_ROOT/git-readyz.json"; then
      return 0
    fi
    sleep 1
  done
  tail -n 200 "$SYSTEMCTL_SHIM_DAEMON_LOG" >&2
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
    if git_release_readyz >/dev/null; then
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

# What the install looks like after a baseline's own update: recorded, not asserted.
git_release_record_layout() {
  local label="$1" slot
  {
    for slot in "$git_prefix/openclaw" "$git_prefix/lib/node_modules/openclaw" "$git_checkout"; do
      if [ -e "$slot" ]; then
        printf '%s -> %s head=%s version=%s\n' "$slot" "$(realpath "$slot")" \
          "$(git -C "$slot" rev-parse HEAD 2>/dev/null || echo none)" \
          "$(node "$slot/openclaw.mjs" --version 2>/dev/null || echo unavailable)"
      else
        printf '%s absent\n' "$slot"
      fi
    done
    printf 'checkout branch: %s\n' "$(git -C "$git_checkout" symbolic-ref -q HEAD || echo detached)"
    grep -F 'ExecStart' "$(git_release_unit)" 2>/dev/null || echo 'no service unit'
  } | tee "$ARTIFACT_ROOT/$label-layout.txt"
}

# 7db69bedeab6 only: an update to the baseline itself converts the checkout to its
# lib/node_modules release layout; later hops it drives are recorded.
git_release_update_7db() {
  local label="$1" target="$2" result=0
  git_release_mark
  git_release_cli --version >"$ARTIFACT_ROOT/$label-driver.txt"
  git -C "$git_upstream" update-ref refs/heads/main "$target"
  git_release_cli update --channel dev --yes --json \
    >"$ARTIFACT_ROOT/$label-update.json" 2>"$ARTIFACT_ROOT/$label-update.err" || result=$?
  printf '%s\n' "$result" >"$ARTIFACT_ROOT/$label-update.exit"
  cat "$(git_release_unit)" >"$ARTIFACT_ROOT/$label-service.txt"
  if [ "$label" = baseline ]; then
    # 7db69bedeab6 converts the checkout but reports the checkout's service as
    # foreign and leaves it untouched; git_release_adopt_launcher moves it.
    [ "$result" -eq 0 ]
  else
    # 7db69bedeab6 drives this hop while its Gateway cannot start; record the outcome.
    git_release_settle "$label"
  fi
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
  tee "$ARTIFACT_ROOT/baseline-launcher-service.txt" <"$(git_release_unit)"
  grep -F "$git_prefix/openclaw-launcher.mjs" "$(git_release_unit)"
  if [ "$(cat "$SYSTEMCTL_SHIM_PID_FILE")" = "$previous_pid" ]; then
    systemctl --user restart openclaw-gateway.service
  fi
  git_release_settle baseline
}

git_release_assert_old_layout() {
  local target
  target="$(realpath "$git_prefix/lib/node_modules/openclaw")"
  [[ "$target" == */git-install/releases/*/lib/node_modules/openclaw ]]
  printf '%s %s\n' "$target" "$(git -C "$target" rev-parse HEAD)" | tee "$ARTIFACT_ROOT/$CURRENT_PHASE-layout.txt"
}

# Other baselines: the baseline's own updater, run from the checkout, takes it to the candidate.
git_release_baseline_hop() {
  local result=0
  git_release_mark
  git_release_root="$git_checkout" git_release_cli --version | tee "$ARTIFACT_ROOT/baseline-hop-driver.txt"
  git -C "$git_upstream" update-ref refs/heads/main "$CANDIDATE_SPEC"
  git_release_root="$git_checkout" git_release_cli update --channel dev --yes --json \
    >"$ARTIFACT_ROOT/baseline-hop-update.json" 2>"$ARTIFACT_ROOT/baseline-hop-update.err" || result=$?
  printf '%s\n' "$result" | tee "$ARTIFACT_ROOT/baseline-hop-update.exit"
  git_release_settle baseline-hop
  git_release_record_layout baseline-hop
}

# Where the candidate runs after the baseline's own path: a release link or the checkout.
git_release_find_candidate() {
  local root short="${CANDIDATE_SPEC:0:7}"
  for root in "$git_prefix/openclaw" "$git_prefix/lib/node_modules/openclaw" "$git_checkout"; do
    if [ -e "$root/openclaw.mjs" ] && [ "$(git -C "$root" rev-parse HEAD 2>/dev/null)" = "$CANDIDATE_SPEC" ] &&
      node "$root/openclaw.mjs" --version | grep -qF "$short"; then
      git_release_driver_root="$root"
      echo "candidate driver: $root" | tee "$ARTIFACT_ROOT/candidate-driver.txt"
      return 0
    fi
  done
  echo "The baseline's own update did not leave a built candidate at a release link or the checkout." >&2
  return 1
}

# A new upstream commit on the last good commit. A changed tree is required: the
# updater treats a commit with the running tree as already current. A crash commit
# makes a Gateway started by the release launcher exit before it listens; later good
# commits do not descend from it.
git_release_commit() {
  local label="$1" kind="${2:-good}" index="$RUNTIME_ROOT/git-commit.index" blob tree patched
  rm -f "$index"
  export GIT_AUTHOR_NAME='Upgrade survivor' GIT_AUTHOR_EMAIL='upgrade-survivor@example.invalid'
  export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
  GIT_INDEX_FILE="$index" git -C "$git_upstream" read-tree "$git_release_good_tip"
  blob="$(printf '%s\n' "$label" | git -C "$git_upstream" hash-object -w --stdin)"
  GIT_INDEX_FILE="$index" git -C "$git_upstream" update-index --add --cacheinfo "100644,$blob,upgrade-survivor-proof/$label.txt"
  if [ "$kind" = crash ]; then
    patched="$(git -C "$git_upstream" show "$git_release_good_tip:src/index.ts" | CRASH_LINE="$git_release_crash_line" node -e '
let s = "";
process.stdin.on("data", (c) => (s += c)).on("end", () => {
  const anchor = "const isMain = isMainModule({";
  if (!s.includes(anchor)) process.exit(3);
  const crash = `if ((globalThis as Record<symbol, unknown>)[Symbol.for("openclaw.gitReleaseLauncher")] && process.argv.includes("gateway")) {
  console.error(${JSON.stringify(process.env.CRASH_LINE)});
  process.exit(1);
}
`;
  process.stdout.write(s.replace(anchor, crash + anchor));
});' | git -C "$git_upstream" hash-object -w --stdin)"
    GIT_INDEX_FILE="$index" git -C "$git_upstream" update-index --cacheinfo "100644,$patched,src/index.ts"
  fi
  tree="$(GIT_INDEX_FILE="$index" git -C "$git_upstream" write-tree)"
  git_release_target="$(git -C "$git_upstream" commit-tree "$tree" -p "$git_release_good_tip" -m "upgrade survivor: $label")"
  [ "$kind" = crash ] || git_release_good_tip="$git_release_target"
  printf '%s %s %s\n' "$label" "$kind" "$git_release_target" | tee -a "$ARTIFACT_ROOT/git-commits.txt"
}

git_release_link_id() {
  basename "$(dirname "$(realpath "$git_prefix/openclaw")")"
}

git_release_checkout_snapshot() {
  {
    echo "HEAD $(git -C "$git_checkout" rev-parse HEAD)"
    echo "branch $(git -C "$git_checkout" symbolic-ref -q HEAD || echo detached)"
    echo "main $(git -C "$git_checkout" rev-parse main)"
    git -C "$git_checkout" --no-optional-locks status --porcelain
    stat -c 'dist %n %s %Y' "$git_checkout/dist/index.js" "$git_checkout/dist/build-info.json" 2>/dev/null || echo 'dist absent'
  } >"$1"
}

# I6: the candidate's update leaves the checkout's HEAD, branch, tracked files and dist.
git_release_check_untouched() {
  local label="$1"
  git_release_checkout_snapshot "$ARTIFACT_ROOT/$label-checkout-after.txt"
  diff -u "$ARTIFACT_ROOT/$label-checkout-before.txt" "$ARTIFACT_ROOT/$label-checkout-after.txt" |
    tee "$ARTIFACT_ROOT/$label-checkout.diff"
  echo "$label: checkout unchanged ($(head -n 1 "$ARTIFACT_ROOT/$label-checkout-after.txt"))"
}

# I1: the link resolves to a release outside node_modules built from `sha`. An earlier
# lib/node_modules link, if any, follows that link (its old callers keep working).
git_release_assert_release() {
  local label="$1" sha="$2" target legacy="$git_prefix/lib/node_modules/openclaw"
  target="$(realpath "$git_prefix/openclaw")"
  printf 'link %s -> %s head=%s\n' "$(readlink "$git_prefix/openclaw")" "$target" "$(git -C "$target" rev-parse HEAD)" |
    tee "$ARTIFACT_ROOT/$label-layout.txt"
  [[ "$target" == */git-install/releases/*/openclaw && "$target" != */node_modules/* ]]
  if [ -e "$legacy" ] || [ -L "$legacy" ]; then
    printf 'legacy %s -> %s\n' "$(readlink "$legacy")" "$(realpath "$legacy")" | tee -a "$ARTIFACT_ROOT/$label-layout.txt"
    [ "$(realpath "$legacy")" = "$target" ]
  fi
  [ "$(git -C "$target" rev-parse HEAD)" = "$sha" ]
}

# Ready, and a live Gateway process holds the lease of release `want`.
git_release_wait_serving() {
  local label="$1" want="$2" attempt
  for attempt in $(seq 1 300); do
    if git_release_readyz >"$ARTIFACT_ROOT/$label-readyz.json" &&
      node "$git_release_helper" serving "$git_prefix" >"$ARTIFACT_ROOT/$label-serving.json" &&
      node -e 'const s=require(process.argv[1]);process.exit(s.leased[process.argv[2]]?0:1)' \
        "$ARTIFACT_ROOT/$label-serving.json" "$want"; then
      echo "$label: release $want serves: $(cat "$ARTIFACT_ROOT/$label-serving.json")"
      return 0
    fi
    sleep 1
  done
  echo "$label: release $want is not serving" >&2
  cat "$ARTIFACT_ROOT/$label-serving.json" >&2 || true
  tail -n 200 "$SYSTEMCTL_SHIM_DAEMON_LOG" >&2
  return 1
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
  case "$expected" in
    fail)
      grep -E "$git_release_strip_error" "$ARTIFACT_ROOT/$label-gateway.log" | grep -F 'web-search-contract-api' | head -n 3
      if [ "$result" -eq 0 ]; then
        node -e 'const r=require(process.argv[1]);if(r.ok!==false)throw Error("Expected failed invocation")' "$ARTIFACT_ROOT/$label-request.json"
      fi
      ;;
    record)
      echo "$label: request exit $result; stripping errors: $(grep -cE "$git_release_strip_error" "$ARTIFACT_ROOT/$label-gateway.log" || true); $(head -c 300 "$ARTIFACT_ROOT/$label-request.json")" |
        tee "$ARTIFACT_ROOT/$label-request-observed.txt"
      ;;
    *)
      [ "$result" -eq 0 ]
      node -e 'const r=require(process.argv[1]);if(r.ok!==true||r.toolName!=="web_search")throw Error(JSON.stringify(r));console.log("web_search construction and invocation succeeded: "+JSON.stringify(r).slice(0,400))' "$ARTIFACT_ROOT/$label-request.json"
      ! grep -E "$git_release_strip_error" "$ARTIFACT_ROOT/$label-gateway.log"
      ;;
  esac
}

git_release_before_update() {
  local label="$1" target="$2"
  git_release_mark
  git_shim_lines="$(wc -l <"$SYSTEMCTL_SHIM_LOG")"
  git_release_checkout_snapshot "$ARTIFACT_ROOT/$label-checkout-before.txt"
  git -C "$git_upstream" update-ref refs/heads/main "$target"
}

# The end state of every successful candidate update with a service: the unit starts the
# launcher, the link names a release of `target` outside node_modules, that release serves,
# the checkout is unchanged, and a plugin tool call succeeds with no stripping error.
git_release_after_update() {
  local label="$1" target="$2" previous="$3"
  tail -n +"$((git_shim_lines + 1))" "$SYSTEMCTL_SHIM_LOG" >"$ARTIFACT_ROOT/$label-systemctl.log"
  cp "$(git_release_unit)" "$ARTIFACT_ROOT/$label-service.txt"
  grep -F "$git_prefix/openclaw-launcher.mjs" "$(git_release_unit)" >/dev/null
  git_release_assert_release "$label" "$target"
  git_release_wait_serving "$label" "$(git_release_link_id)"
  # Evidence of the switch window, then a fresh mark: an old-layout Gateway
  # restarted before the link moved may still log the stripping error here.
  git_release_slice "$label-update"
  git_release_mark
  git_release_check_untouched "$label"
  echo "$label: link ${previous:-none} -> $(readlink "$git_prefix/openclaw")" | tee "$ARTIFACT_ROOT/$label-link.txt"
  git_release_request "$label" pass
}

git_release_candidate_update() {
  local label="$1" target="$2" result=0 previous
  shift 2
  previous="$(readlink "$git_prefix/openclaw" || true)"
  git_release_before_update "$label" "$target"
  git_release_cli update "$@" --yes --json \
    >"$ARTIFACT_ROOT/$label-update.json" 2>"$ARTIFACT_ROOT/$label-update.err" || result=$?
  printf '%s\n' "$result" >"$ARTIFACT_ROOT/$label-update.exit"
  if [ "$result" -ne 0 ]; then
    cat "$ARTIFACT_ROOT/$label-update.json" "$ARTIFACT_ROOT/$label-update.err" >&2
    return "$result"
  fi
  git_release_after_update "$label" "$target" "$previous"
}

git_release_first_own_update() {
  git_release_commit first-own
  git_release_root="$git_release_driver_root" git_release_candidate_update first-own "$git_release_target" --channel dev
}

# I5: the release runs its own updater: node <state>/git-install/openclaw/openclaw.mjs update --yes.
git_release_self_update() {
  git_release_commit self-update
  git_release_root="$git_prefix/openclaw" git_release_candidate_update self-update "$git_release_target"
}

# I14: one update through the Gateway's update.run; update.runs.get reports its end.
git_release_gateway_update() {
  local label=update-run previous run_id status="" attempt
  git_release_commit "$label"
  previous="$(readlink "$git_prefix/openclaw")"
  git_release_before_update "$label" "$git_release_target"
  git_release_cli gateway call update.run --url ws://127.0.0.1:18789 --token upgrade-survivor-token \
    --params '{}' --timeout 120000 --json | tee "$ARTIFACT_ROOT/$label-call.json"
  run_id="$(node -e 'const r=require(process.argv[1]);if(!r.runId||r.ok!==true)throw Error(JSON.stringify(r));console.log(r.runId)' "$ARTIFACT_ROOT/$label-call.json")"
  for attempt in $(seq 1 360); do
    sleep 5
    if git_release_cli gateway call update.runs.get --url ws://127.0.0.1:18789 --token upgrade-survivor-token \
      --params "{\"runId\":\"$run_id\"}" --timeout 10000 --json >"$ARTIFACT_ROOT/$label-run.json" 2>/dev/null; then
      status="$(node -e 'console.log(require(process.argv[1]).run?.status ?? "missing")' "$ARTIFACT_ROOT/$label-run.json")"
      [ "$status" = running ] || break
    fi
  done
  echo "$label: run $run_id finished $status" | tee "$ARTIFACT_ROOT/$label-status.txt"
  if [ "$status" != succeeded ]; then
    cat "$ARTIFACT_ROOT/$label-run.json" >&2 || true
    return 1
  fi
  git_release_after_update "$label" "$git_release_target" "$previous"
}

git_release_pre_files() {
  find "$OPENCLAW_STATE_DIR" -path "$git_prefix" -prune -o -name '*.pre-*' -print | sort
}

# Waits for the launcher's switch-back after the crash release's failed starts.
git_release_wait_switch_back() {
  local label="$1" previous="$2" previous_id="$3" attempt
  for attempt in $(seq 1 600); do
    git_release_slice "$label-switch-back"
    if grep -F "$git_release_switch_back" "$ARTIFACT_ROOT/$label-switch-back-gateway.log"; then
      break
    fi
    sleep 1
  done
  grep -F "$git_release_switch_back" "$ARTIFACT_ROOT/$label-switch-back-gateway.log" >/dev/null
  echo "$label: crash release starts logged: $(grep -cF "$git_release_crash_line" "$ARTIFACT_ROOT/$label-switch-back-gateway.log" || true)" |
    tee "$ARTIFACT_ROOT/$label-crash-starts.txt"
  [ "$(readlink "$git_prefix/openclaw")" = "$previous" ]
  [ ! -e "$git_prefix/releases/.trial" ]
  git_release_wait_serving "$label" "$previous_id"
}

git_release_assert_pre_restored() {
  local label="$1"
  git_release_pre_files >"$ARTIFACT_ROOT/$label-pre-after.txt"
  # A trial's .pre-<generation> files are renamed back over their originals.
  if ! diff -u "$ARTIFACT_ROOT/$label-pre-before.txt" "$ARTIFACT_ROOT/$label-pre-after.txt"; then
    echo "$label: .pre- files changed across the trial" >&2
    return 1
  fi
  echo "$label: .pre- files before the update: $(wc -l <"$ARTIFACT_ROOT/$label-pre-before.txt"), after the switch-back: $(wc -l <"$ARTIFACT_ROOT/$label-pre-after.txt")"
}

# I4: the release on trial exits before listening; two failed starts switch back.
git_release_crash_release() {
  local label=crash-release previous previous_id result=0
  git_release_commit "$label" crash
  previous="$(readlink "$git_prefix/openclaw")"
  previous_id="$(git_release_link_id)"
  git_release_pre_files >"$ARTIFACT_ROOT/$label-pre-before.txt"
  git_release_before_update "$label" "$git_release_target"
  git_release_cli update --channel dev --yes --json \
    >"$ARTIFACT_ROOT/$label-update.json" 2>"$ARTIFACT_ROOT/$label-update.err" || result=$?
  echo "$label: updater exit $result" | tee "$ARTIFACT_ROOT/$label-update.exit"
  tail -n +"$((git_shim_lines + 1))" "$SYSTEMCTL_SHIM_LOG" >"$ARTIFACT_ROOT/$label-systemctl.log"
  git_release_wait_switch_back "$label" "$previous" "$previous_id"
  git_release_assert_pre_restored "$label"
  git_release_slice "$label-update"
  git_release_mark
  git_release_check_untouched "$label"
  git_release_request "$label" pass
}

# I3 stage, build, publish, link-switch: kill -9 the updater's process group at the point,
# then the install still serves a release, the call succeeds, and a rerun update succeeds.
git_release_kill_point() {
  local point="$1" label="kill-$1" previous previous_id serving_id
  git_release_commit "$label"
  previous="$(readlink "$git_prefix/openclaw")"
  previous_id="$(git_release_link_id)"
  git_release_before_update "$label" "$git_release_target"
  node "$git_release_helper" kill "$point" "$git_prefix" "$ARTIFACT_ROOT/$label.json" \
    "$ARTIFACT_ROOT/$label-update.json" "$ARTIFACT_ROOT/$label-update.err" -- \
    "${git_release_env[@]}" node "$git_prefix/openclaw/openclaw.mjs" update --channel dev --yes --json
  if [ "$point" = link-switch ]; then
    # The link names the new release; its Gateway follows the link.
    [ "$(readlink "$git_prefix/openclaw")" != "$previous" ]
    serving_id="$(git_release_link_id)"
  else
    [ "$(readlink "$git_prefix/openclaw")" = "$previous" ]
    serving_id="$previous_id"
  fi
  git_release_wait_serving "$label" "$serving_id"
  git_release_slice "$label-update"
  git_release_mark
  git_release_check_untouched "$label"
  git_release_request "$label" pass
  git_release_candidate_update "$label-rerun" "$git_release_target" --channel dev
}

# I3 launcher-restore: SIGKILL the launcher right after the trial record says `restoring`.
# The crash release fails two starts; at the second, the service is stopped, and the third
# start runs the unit's own ExecStart by hand with a preload that kills the launcher at that
# write. The service's next start finishes the restore.
git_release_kill_launcher_restore() {
  local label=kill-launcher-restore previous previous_id updater_pid attempt command hooked status=0
  local trial="$git_prefix/releases/.trial" launcher="$git_prefix/openclaw-launcher.mjs"
  local hook="$git_release_lib/git-release-launcher-kill.mjs" marker="$ARTIFACT_ROOT/kill-launcher-restore-marker.json"
  git_release_commit "$label" crash
  previous="$(readlink "$git_prefix/openclaw")"
  previous_id="$(git_release_link_id)"
  git_release_pre_files >"$ARTIFACT_ROOT/$label-pre-before.txt"
  git_release_before_update "$label" "$git_release_target"
  (
    result=0
    git_release_cli update --channel dev --yes --json \
      >"$ARTIFACT_ROOT/$label-update.json" 2>"$ARTIFACT_ROOT/$label-update.err" || result=$?
    printf '%s\n' "$result" >"$ARTIFACT_ROOT/$label-update.exit"
  ) &
  updater_pid=$!
  for attempt in $(seq 1 18000); do
    if [ -f "$trial" ] && node -e 'const t=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.exit(t.attempts>=2&&!t.restoring?0:1)' "$trial" 2>/dev/null; then
      break
    fi
    if ! kill -0 "$updater_pid" 2>/dev/null && [ ! -f "$trial" ]; then
      echo "$label: the updater ended without a trial reaching two starts" >&2
      cat "$ARTIFACT_ROOT/$label-update.json" "$ARTIFACT_ROOT/$label-update.err" >&2 || true
      return 1
    fi
    sleep 0.2
  done
  systemctl --user stop openclaw-gateway.service
  cp "$trial" "$ARTIFACT_ROOT/$label-trial-before-kill.json"
  node -e 'const t=require(process.argv[1]);if(t.attempts<2||t.restoring)throw Error("missed: "+JSON.stringify(t))' "$ARTIFACT_ROOT/$label-trial-before-kill.json"
  command="$(node "$BASELINE_BIN_DIR/systemd-fixture.mjs" command)"
  hooked="${command/"'$launcher'"/"'--import=$hook' '$launcher'"}"
  [ "$hooked" != "$command" ]
  printf '%s\n' "$hooked" >"$ARTIFACT_ROOT/$label-command.txt"
  OPENCLAW_UPGRADE_SURVIVOR_LAUNCHER_KILL_MARKER="$marker" timeout 300 bash -c "$hooked" \
    >>"$SYSTEMCTL_SHIM_DAEMON_LOG" 2>&1 || status=$?
  echo "$label: hooked launcher exit $status" | tee "$ARTIFACT_ROOT/$label-kill.txt"
  [ "$status" -eq 137 ] && [ -s "$marker" ]
  cp "$trial" "$ARTIFACT_ROOT/$label-trial-after-kill.json"
  node -e 'const t=require(process.argv[1]);if(!t.restoring)throw Error(JSON.stringify(t));console.log("trial at kill: "+JSON.stringify(t))' "$ARTIFACT_ROOT/$label-trial-after-kill.json"
  [ "$(readlink "$git_prefix/openclaw")" != "$previous" ]
  systemctl --user start openclaw-gateway.service
  git_release_wait_switch_back "$label" "$previous" "$previous_id"
  wait "$updater_pid" || true
  echo "$label: updater exit $(cat "$ARTIFACT_ROOT/$label-update.exit")"
  git_release_assert_pre_restored "$label"
  git_release_slice "$label-update"
  git_release_mark
  git_release_check_untouched "$label"
  git_release_request "$label" pass
  git_release_commit "$label-rerun"
  git_release_candidate_update "$label-rerun" "$git_release_target" --channel dev
}

git_release_candidate_steps() {
  local point
  phase git-candidate-first-own-update git_release_first_own_update
  phase git-candidate-self-update git_release_self_update
  phase git-candidate-update-run git_release_gateway_update
  phase git-candidate-crash-release git_release_crash_release
  for point in ${OPENCLAW_UPGRADE_SURVIVOR_GIT_KILL_POINTS:-stage build publish link-switch launcher-restore}; do
    if [ "$point" = launcher-restore ]; then
      phase git-kill-launcher-restore git_release_kill_launcher_restore
    else
      phase "git-kill-$point" git_release_kill_point "$point"
    fi
  done
}

run_git_release_baseline() {
  local baseline_sha="$OPENCLAW_UPGRADE_SURVIVOR_GIT_BASELINE_SHA"
  phase git-checkout-baseline git_release_checkout "$baseline_sha"
  phase git-build-baseline git_release_build_checkout
  phase git-install-service git_release_install_service
  if [ "$baseline_sha" = "$(git -C "$git_checkout" rev-parse '7db69bedeab6^{commit}')" ]; then
    phase git-baseline-convert git_release_update_7db baseline "$baseline_sha"
    phase git-baseline-layout git_release_assert_old_layout
    phase git-baseline-adopt-launcher git_release_adopt_launcher
    phase git-baseline-reproduce git_release_request baseline fail
    # The release's own CLI is the reporter's `openclaw`; record whether 7db69bedeab6
    # can update from inside node_modules, then drive the hop from the checkout.
    phase git-first-hop-release-cli git_release_update_7db first-hop-release-cli "$CANDIDATE_SPEC"
    git_release_root="$git_checkout" phase git-baseline-hop git_release_update_7db first-hop "$CANDIDATE_SPEC"
    phase git-baseline-hop-layout git_release_record_layout first-hop
    phase git-baseline-hop-observe git_release_request first-hop record
  else
    phase git-baseline-request git_release_request baseline record
    phase git-baseline-hop git_release_baseline_hop
    phase git-baseline-hop-observe git_release_request baseline-hop record
  fi
  phase git-find-candidate git_release_find_candidate
  git_release_candidate_steps
}

git_release_no_service_update() {
  local label=no-service result=0
  git_release_commit "$label"
  git_release_before_update "$label" "$git_release_target"
  git_release_root="$git_checkout" git_release_cli update --channel dev --yes --json \
    >"$ARTIFACT_ROOT/$label-update.json" 2>"$ARTIFACT_ROOT/$label-update.err" || result=$?
  printf '%s\n' "$result" >"$ARTIFACT_ROOT/$label-update.exit"
  if [ "$result" -ne 0 ]; then
    cat "$ARTIFACT_ROOT/$label-update.json" "$ARTIFACT_ROOT/$label-update.err" >&2
    return "$result"
  fi
  git_release_assert_release "$label" "$git_release_target"
  [ ! -e "$(git_release_unit)" ]
  [ -f "$git_prefix/openclaw-launcher.mjs" ]
  git_release_check_untouched "$label"
}

# I9: the next manual start, through the launcher, runs the new release.
git_release_manual_start() {
  (cd "$HOME" && exec "${git_release_env[@]}" node "$git_prefix/openclaw-launcher.mjs" gateway --port 18789) \
    >>"$SYSTEMCTL_SHIM_DAEMON_LOG" 2>&1 &
  gateway_pid=$!
  git_release_wait_serving no-service "$(git_release_link_id)"
}

run_git_release_no_service() {
  phase git-checkout-candidate git_release_checkout "$CANDIDATE_SPEC"
  phase git-build-candidate git_release_build_checkout
  phase git-write-config git_release_write_config
  phase git-no-service-update git_release_no_service_update
  phase git-no-service-manual-start git_release_manual_start
  phase git-no-service-request git_release_request no-service pass
}

git_release_install_package() {
  local spec="${OPENCLAW_UPGRADE_SURVIVOR_GIT_PACKAGE_SPEC:-openclaw@latest}"
  # A local-disk prefix, as users have: the artifact bind mount breaks the package swap's
  # hardlink publication checks (path-mismatch).
  npm_config_prefix="$RUNTIME_ROOT/npm-prefix"
  export npm_config_prefix NPM_CONFIG_PREFIX="$npm_config_prefix"
  BASELINE_PACKAGE_ROOT="$npm_config_prefix/lib/node_modules/openclaw"
  BASELINE_BIN_DIR="$npm_config_prefix/bin"
  export PATH="$BASELINE_BIN_DIR:$PATH"
  mkdir -p "$BASELINE_BIN_DIR"
  openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" \
    npm install -g --prefix "$npm_config_prefix" "$spec" --no-fund --no-audit >"$BASELINE_INSTALL_LOG" 2>&1
  { echo "$spec"; command -v openclaw; git_release_path_cli --version; } | tee "$ARTIFACT_ROOT/package-version.txt"
}

# The published updater runs the switch; its result is recorded, not asserted.
git_release_package_switch() {
  local result=0
  git_release_mark
  git_release_path_cli update --channel dev --yes --json \
    >"$ARTIFACT_ROOT/package-switch-update.json" 2>"$ARTIFACT_ROOT/package-switch-update.err" || result=$?
  printf '%s\n' "$result" | tee "$ARTIFACT_ROOT/package-switch-update.exit"
  git_release_settle package-switch
  git_release_record_layout package-switch
  {
    command -v openclaw
    git_release_path_cli --version || true
    head -n 5 "$BASELINE_PACKAGE_ROOT/openclaw.mjs" || true
  } | tee "$ARTIFACT_ROOT/package-switch-path.txt"
}

# I8: one more update from `openclaw` on PATH ends with a Git release serving that PATH runs.
git_release_package_second() {
  local label=package-second result=0 previous
  git_release_commit "$label"
  previous="$(readlink "$git_prefix/openclaw" || true)"
  git_release_before_update "$label" "$git_release_target"
  git_release_path_cli update --yes --json \
    >"$ARTIFACT_ROOT/$label-update.json" 2>"$ARTIFACT_ROOT/$label-update.err" || result=$?
  printf '%s\n' "$result" >"$ARTIFACT_ROOT/$label-update.exit"
  if [ "$result" -ne 0 ]; then
    cat "$ARTIFACT_ROOT/$label-update.json" "$ARTIFACT_ROOT/$label-update.err" >&2
    return "$result"
  fi
  git_release_after_update "$label" "$git_release_target" "$previous"
  git_release_path_cli --version | tee "$ARTIFACT_ROOT/$label-path-version.txt"
  grep -qF "${git_release_target:0:7}" "$ARTIFACT_ROOT/$label-path-version.txt"
}

# A switch whose first Git build never listens goes back to the npm package that served:
# two failed starts, then the Gateway and `openclaw` on PATH run the package again.
git_release_package_crash() {
  local label=package-crash result=0 attempt package_root
  package_root="$(realpath "$BASELINE_PACKAGE_ROOT")"
  git_release_commit "$label" crash
  git_release_before_update "$label" "$git_release_target"
  git_release_path_cli update --channel dev --yes --json \
    >"$ARTIFACT_ROOT/$label-update.json" 2>"$ARTIFACT_ROOT/$label-update.err" || result=$?
  echo "$label: updater exit $result" | tee "$ARTIFACT_ROOT/$label-update.exit"
  for attempt in $(seq 1 600); do
    git_release_slice "$label-switch-back"
    grep -qF "$git_release_switch_back" "$ARTIFACT_ROOT/$label-switch-back-gateway.log" && break
    sleep 1
  done
  grep -F "$git_release_switch_back" "$ARTIFACT_ROOT/$label-switch-back-gateway.log"
  echo "$label: crash release starts logged: $(grep -cF "$git_release_crash_line" "$ARTIFACT_ROOT/$label-switch-back-gateway.log" || true)" |
    tee "$ARTIFACT_ROOT/$label-crash-starts.txt"
  [ "$(realpath "$git_prefix/openclaw")" = "$package_root" ]
  git_release_settle "$label"
  grep -qx ready "$ARTIFACT_ROOT/$label-settled.txt"
  git_release_path_cli --version | tee "$ARTIFACT_ROOT/$label-path-version.txt"
  grep -qF "$(node -p 'require(process.argv[1]).version' "$package_root/package.json")" \
    "$ARTIFACT_ROOT/$label-path-version.txt"
  git_release_check_untouched "$label"
}

run_git_release_package_to_git() {
  phase git-install-package git_release_install_package
  phase git-install-service git_release_install_service git_release_path_cli
  phase git-package-request git_release_request package record
  phase git-checkout-candidate git_release_checkout "$CANDIDATE_SPEC"
  export OPENCLAW_GIT_DIR="$git_checkout"
  if [ "${OPENCLAW_UPGRADE_SURVIVOR_GIT_PACKAGE_SPEC:-}" = /tmp/openclaw-current.tgz ]; then
    phase git-package-crash-switch git_release_package_crash
    phase git-package-crash-observe git_release_request package-crash record
    git -C "$git_upstream" update-ref refs/heads/main "$git_release_good_tip"
  fi
  phase git-package-switch git_release_package_switch
  phase git-package-switch-observe git_release_request package-switch record
  phase git-package-second-update git_release_package_second
}

run_git_release_survivor() {
  local route="${OPENCLAW_UPGRADE_SURVIVOR_GIT_ROUTE:-baseline}"
  normalize_baseline
  [ "$baseline_spec" = openclaw@2026.11.5 ] && [ "$CANDIDATE_KIND" = git ]
  phase git-initialize-state initialize_state
  unset OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY DISCORD_BOT_TOKEN TELEGRAM_BOT_TOKEN
  git_checkout="$RUNTIME_ROOT/git-checkout"
  git_upstream="$RUNTIME_ROOT/git-upstream.git"
  candidate_install_mode=git
  git_release_init
  echo "git-release route $route baseline ${OPENCLAW_UPGRADE_SURVIVOR_GIT_BASELINE_LABEL:-} ${OPENCLAW_UPGRADE_SURVIVOR_GIT_BASELINE_SHA:-} candidate $CANDIDATE_SPEC" |
    tee "$ARTIFACT_ROOT/git-route.txt"
  case "$route" in
    baseline) run_git_release_baseline ;;
    no-service) run_git_release_no_service ;;
    package-to-git) run_git_release_package_to_git ;;
    *)
      echo "Unknown OPENCLAW_UPGRADE_SURVIVOR_GIT_ROUTE: $route" >&2
      return 2
      ;;
  esac
  installed_version="$candidate_version"
  echo "Git release survivor passed: route $route."
}
