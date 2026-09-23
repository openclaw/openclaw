#!/usr/bin/env bash
set -euo pipefail

readonly SUT_USER="openclaw-sut"
readonly RUNNER_USER="openclaw-bench"
readonly NODE_VERSION="24.19.0"
readonly NODE_SHA256="14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647"
readonly PNPM_VERSION="11.15.1"
readonly OCM_BINARY="/opt/openclaw-performance/ocm"
readonly CRABBOX_COMMIT="8ba71f913bbe57285ae29af45ef0d8ec6712477d"
readonly MAX_ARTIFACT_FILES=256
readonly MAX_ARTIFACT_BYTES=250000000
readonly MAX_ARTIFACT_FILE_BYTES=50000000
VERIFY_TMP=""

build_helpers() {
  local version output=".github/crabbox/performance-control/helpers"
  [[ ! -e "$output" && ! -L "$output" ]] || die "helper output must be fresh"
  version="$(node -p 'require("./package.json").devDependencies.esbuild')"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "esbuild must be pinned"
  npm exec --yes --package="esbuild@$version" -- esbuild \
    scripts/lib/kova-report-selector.mjs scripts/lib/kova-workflow-evidence.mts \
    scripts/lib/kova-report-gate.mts scripts/kova-ci-summary.mts \
    scripts/bench-cli-startup.ts scripts/openclaw-performance-source-summary.mts \
    --bundle --platform=node --format=esm --target=node24 --outbase=scripts \
    --outdir="$output" --out-extension:.js=.mjs \
    --alias:@openclaw/normalization-core/record-coerce=./packages/normalization-core/src/record-coerce.ts
  [[ "$(find "$output" -type f | LC_ALL=C sort)" == "$(printf '%s\n' \
    "$output/bench-cli-startup.mjs" "$output/kova-ci-summary.mjs" \
    "$output/lib/kova-report-gate.mjs" "$output/lib/kova-report-selector.mjs" \
    "$output/lib/kova-workflow-evidence.mjs" "$output/openclaw-performance-source-summary.mjs")" ]] ||
    die "unexpected helper bundle set"
}

die() {
  printf 'openclaw-performance-crabbox: %s\n' "$*" >&2
  exit 1
}

require_sha() {
  [[ "$2" =~ ^[0-9a-f]{40}$ ]] || die "$1 must be a 40-character lowercase SHA"
}

require_scalar() {
  [[ -n "$2" && ${#2} -le 256 && "$2" != *$'\n'* && "$2" != *$'\r'* ]] ||
    die "$1 must be a single line of at most 256 characters"
}

file_size() {
  stat -c %s "$1" 2>/dev/null || stat -f %z "$1"
}

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

as_sut() {
  local uid
  uid="$(id -u "$SUT_USER")"
  runuser -u "$SUT_USER" -- /usr/bin/env -C "/home/${SUT_USER}" -i \
    HOME="/home/${SUT_USER}" \
    XDG_CACHE_HOME="/home/${SUT_USER}/.cache" \
    XDG_RUNTIME_DIR="/run/user/${uid}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uid}/bus" \
    PATH="/home/${SUT_USER}/.local/node_modules/.bin:/opt/node-v${NODE_VERSION}/bin:/opt/openclaw-performance:/usr/bin:/bin" \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_SYSTEM=/dev/null \
    GIT_TERMINAL_PROMPT=0 \
    CI=1 \
    OPENCLAW_SKIP_CHANNELS=1 \
    OPENCLAW_SKIP_CRON=1 \
    "$@"
}

as_runner() {
  runuser -u "$RUNNER_USER" -- /usr/bin/env -C "/home/${RUNNER_USER}" -i \
    HOME="/home/${RUNNER_USER}" \
    XDG_CACHE_HOME="/home/${RUNNER_USER}/.cache" \
    PATH="/opt/node-v${NODE_VERSION}/bin:/usr/bin:/bin" \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 CI=1 \
    "$@"
}

candidate_environment() {
  printf '%s\n' \
    "HOME=/home/${SUT_USER}" \
    "XDG_CACHE_HOME=/home/${SUT_USER}/.cache" \
    "XDG_RUNTIME_DIR=/run/user/$(id -u "$SUT_USER")" \
    "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u "$SUT_USER")/bus" \
    "PATH=/home/${SUT_USER}/.local/node_modules/.bin:/opt/node-v${NODE_VERSION}/bin:/opt/openclaw-performance:/usr/bin:/bin" \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 \
    CI=1 OPENCLAW_SKIP_CHANNELS=1 OPENCLAW_SKIP_CRON=1
}

as_candidate() {
  local entry env_args=()
  while IFS= read -r entry; do env_args+=("$entry"); done < <(candidate_environment)
  /usr/bin/sudo -n -u "$SUT_USER" -- /usr/bin/env -C "/home/${SUT_USER}" -i "${env_args[@]}" "$@"
}

candidate_transport() {
  candidate_environment | jq -Rn --arg binary "$1" --arg user "$SUT_USER" '
    [inputs | capture("^(?<key>[^=]+)=(?<value>.*)$")] | from_entries |
    {prefix:["/usr/bin/sudo","-n","-u",$user,"--"],binary:$binary,env:.,cwd:.HOME}'
}

clone_exact() {
  local repository="$1" sha="$2" destination="$3" owner="$4"
  local executor=as_sut
  [[ "$owner" != "$RUNNER_USER" ]] || executor=as_runner
  install -d -m 0700 -o "$owner" -g "$owner" "$destination"
  "$executor" /usr/bin/git -C "$destination" init -b main
  "$executor" /usr/bin/git -C "$destination" remote add origin "https://github.com/${repository}.git"
  "$executor" /usr/bin/git -C "$destination" fetch --filter=blob:none --depth=1 origin "$sha"
  "$executor" /usr/bin/git -C "$destination" checkout --detach FETCH_HEAD
  [[ "$("$executor" /usr/bin/git -C "$destination" rev-parse HEAD)" == "$sha" ]] ||
    die "${repository} checkout drifted"
  [[ "$("$executor" /usr/bin/git -C "$destination" remote get-url origin)" == "https://github.com/${repository}.git" ]] ||
    die "${repository} origin changed"
}

install_toolchain() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git iptables jq procps sudo tar xz-utils >/dev/null

  local node_root="/opt/node-v${NODE_VERSION}" node_archive="/tmp/node.tar.xz"
  curl -fsSL --proto '=https' --tlsv1.2 --max-time 180 \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    -o "$node_archive"
  echo "${NODE_SHA256}  ${node_archive}" | sha256sum -c -
  rm -rf "$node_root"
  mkdir -p "$node_root"
  tar -xJf "$node_archive" -C "$node_root" --strip-components=1
  [[ "$("$node_root/bin/node" --version)" == "v${NODE_VERSION}" ]] || die "Node version mismatch"

  local payload="$PWD/.github/crabbox/performance-control"
  [[ -f "$payload/ocm" && ! -L "$payload/ocm" ]] || die "trusted OCM build is missing"
  (cd "$payload" && sha256sum -c ocm.sha256)
  install -D -o root -g root -m 0755 "$payload/ocm" "$OCM_BINARY"
  "$OCM_BINARY" env artifact export --help >/dev/null ||
    die "OCM build does not support bounded artifact export"
}

prepare_metadata_denial() {
  local user="$1" executor="$2" uid
  uid="$(id -u "$user")"
  local firewall destination curl_bin curl_version family url http_code probe_status
  for firewall in iptables ip6tables; do
    command -v "$firewall" >/dev/null || die "metadata protection requires ${firewall}"
  done
  curl_bin="$(command -v curl)" || die "metadata protection requires curl"
  [[ "$curl_bin" == /* && -x "$curl_bin" ]] || die "metadata curl is not an executable path"
  curl_version="$("$executor" "$curl_bin" -q --version)" || die "metadata curl is unavailable to $user"
  grep -Eq '^Protocols:.*[[:space:]]http([[:space:]]|$)' <<< "$curl_version" &&
    grep -Eq '^Features:.*[[:space:]]IPv6([[:space:]]|$)' <<< "$curl_version" ||
    die "metadata curl requires HTTP and IPv6 support"

  for destination in 169.254.169.254/32 169.254.170.2/32 fd00:ec2::254/128; do
    firewall=iptables
    [[ "$destination" != fd00:* ]] || firewall=ip6tables
    "$firewall" -I OUTPUT -m owner --uid-owner "$uid" -d "$destination" -j REJECT ||
      die "metadata reject rule insertion failed"
    "$firewall" -C OUTPUT -m owner --uid-owner "$uid" -d "$destination" -j REJECT ||
      die "metadata reject rule verification failed"
  done
  for family in 4 6; do
    url='http://169.254.169.254/latest/meta-data/'
    [[ "$family" != 6 ]] || url='http://[fd00:ec2::254]/latest/meta-data/'
    probe_status=0
    # Preserve trailing bytes: only an exact curl 000 with connection failure is evidence.
    http_code="$(
      status=0
      "$executor" "$curl_bin" -q "-${family}" --noproxy '*' --silent \
        --connect-timeout 1 --max-time 2 --output /dev/null --write-out '%{http_code}' \
        "$url" 2>/dev/null || status=$?
      printf '.'
      exit "$status"
    )" || probe_status=$?
    [[ "$probe_status" == 7 && "$http_code" == "000." ]] ||
      die "$user IPv${family} metadata denial was not verified"
  done
}

prepare_sut() {
  ! id "$SUT_USER" >/dev/null 2>&1 || die "dedicated lease already has ${SUT_USER}"
  useradd --create-home --shell /bin/bash --user-group "$SUT_USER"
  local uid
  uid="$(id -u "$SUT_USER")"

  install -d -m 0700 -o "$SUT_USER" -g "$SUT_USER" "/home/${SUT_USER}/.cache"
  [[ -z "$(find "/home/${SUT_USER}/.cache" -mindepth 1 -print -quit)" ]] ||
    die "SUT cache is not empty"
  for credential_path in .aws .config/gh .gitconfig .npmrc; do
    [[ ! -e "/home/${SUT_USER}/${credential_path}" ]] ||
      die "SUT home unexpectedly contains ${credential_path}"
  done
  if as_sut sudo -n true >/dev/null 2>&1; then
    die "SUT unexpectedly has sudo"
  fi
  prepare_metadata_denial "$SUT_USER" as_sut

  local dirty_env
  dirty_env="$(as_sut env | grep -E '^(ACTIONS_|AWS_|CRABBOX_|GITHUB_|RUNNER_)' || true)"
  [[ -z "$dirty_env" ]] || die "SUT inherited control-plane environment"

  loginctl enable-linger "$SUT_USER"
  systemctl start "user@${uid}.service"
  [[ -S "/run/user/${uid}/systemd/private" ]] || die "SUT systemd user session is unavailable"
}

prepare_runner() {
  ! id "$RUNNER_USER" >/dev/null 2>&1 || die "dedicated lease already has ${RUNNER_USER}"
  useradd --create-home --shell /bin/bash --user-group "$RUNNER_USER"
  chmod 0700 "/home/${RUNNER_USER}" "/home/${SUT_USER}"
  install -d -m 0700 -o "$RUNNER_USER" -g "$RUNNER_USER" \
    "/home/${RUNNER_USER}/.cache" "/home/${RUNNER_USER}/results"
  prepare_metadata_denial "$RUNNER_USER" as_runner
  # The trusted runner can become only B. Neither benchmark identity can become root.
  printf 'Defaults:%s !use_pty\n%s ALL=(%s) NOPASSWD: /usr/bin/env\n' \
    "$RUNNER_USER" "$RUNNER_USER" "$SUT_USER" > /etc/sudoers.d/openclaw-performance
  chmod 0440 /etc/sudoers.d/openclaw-performance
  visudo -cf /etc/sudoers.d/openclaw-performance
  if as_runner sudo -n -u root /usr/bin/env -i /usr/bin/true >/dev/null 2>&1; then
    die "runner unexpectedly has root authority"
  fi
  [[ "$(as_runner "$0" __candidate-id)" == "$(id -u "$SUT_USER")" ]] ||
    die "runner cannot select the SUT identity"
  for path in /home "/home/${RUNNER_USER}" "/home/${RUNNER_USER}/results" \
    /opt "/opt/node-v${NODE_VERSION}" /usr/local/libexec; do
    if as_sut test -w "$path"; then die "SUT can replace runner ancestor $path"; fi
  done
}

prepare_candidate() {
  cd "$1/openclaw"
  npm --prefix "$HOME/.local" install --no-audit --no-fund "pnpm@${PNPM_VERSION}"
  export PATH="$HOME/.local/node_modules/.bin:$PATH"
  pnpm install --frozen-lockfile
}

run_sut() {
  local lane="$1" root="$2" profile="$3" repeat="$4" contract="$5"
  local include_filters="$6" expected_entries="$7" fail_on_regression="$8"
  local helpers="$9" model="${10}" require_instrumented="${11}" results="${12}"
  local kova="${13}" admitted="${14}"
  local openclaw="$root/openclaw"
  local report_dir="$results/.artifacts/kova/reports/$lane"
  local bundle_dir="$results/.artifacts/kova/bundles/$lane"
  local summary_dir="$results/.artifacts/kova/summaries"

  if [[ "$lane" == "source" ]]; then
    cd "$openclaw"
    local source_dir="$openclaw/.artifacts/openclaw-performance/source/mock-provider"
    mkdir -p "$source_dir/mock-hello"
    if ! node -e "const fs=require('node:fs'); const scripts=require('./package.json').scripts||{}; const extensionProbe=['scripts/profile-extension-memory.mts','scripts/profile-extension-memory.mjs'].some((entry)=>fs.existsSync(entry)); process.exit(scripts['test:gateway:cpu-scenarios'] && scripts['test:extensions:memory'] && scripts.openclaw && fs.existsSync('openclaw.mjs') && extensionProbe ? 0 : 1)"; then
      printf 'Source probes skipped: required probe entry points are unavailable in this tested ref.\n'
      return
    fi
    local supported_startup_cases startup_case
    local startup_case_args=()
    supported_startup_cases="$(
      node --import tsx scripts/bench-gateway-startup.ts --help |
        sed -n 's/^  \([[:alnum:]_-][[:alnum:]_-]*\) (.*/\1/p'
    )"
    for startup_case in default skipChannels preparedRuntimeCatalogStall preparedRuntimeScaleOne preparedRuntimeScaleMany oneInternalHook allInternalHooks fiftyPlugins fiftyStartupLazyPlugins; do
      if grep -Fxq "$startup_case" <<< "$supported_startup_cases"; then
        startup_case_args+=(--startup-case "$startup_case")
      fi
    done
    [[ " ${startup_case_args[*]} " == *" --startup-case default "* ]] ||
      die "target startup benchmark did not advertise its required default case"
    pnpm test:gateway:cpu-scenarios \
      --output-dir "$source_dir/gateway-cpu" --runs "$repeat" --warmup 1 --skip-qa \
      "${startup_case_args[@]}"
    pnpm test:extensions:memory -- --json "$source_dir/extension-memory.json"
    local run_index run_dir
    for ((run_index = 1; run_index <= repeat; run_index++)); do
      run_dir=".artifacts/openclaw-performance/source/mock-provider/mock-hello/run-$(printf '%03d' "$run_index")"
      pnpm openclaw qa suite --provider-mode mock-openai --model "mock-openai/$model" \
        --concurrency 1 --output-dir "$run_dir" --scenario channel-chat-baseline
    done
    if node -e "const fs=require('node:fs'); const scripts=require('./package.json').scripts||{}; process.exit(scripts['test:sqlite:perf:smoke'] && fs.existsSync('scripts/bench-sqlite-state.ts') ? 0 : 1)"; then
      pnpm test:sqlite:perf:smoke
      cp .artifacts/sqlite-perf/smoke.json "$source_dir/sqlite-perf-smoke.json"
    else
      echo "SQLite state smoke probe is unavailable in this tested ref; continuing with the remaining source probes."
    fi
    return
  fi

  cd "$results"
  npm --prefix "$kova" ci --ignore-scripts --no-audit --no-fund
  export KOVA_HOME="$HOME/.kova"
  kova() { node "$kova/bin/kova.mjs" "$@"; }
  if [[ "$admitted" == true ]]; then
    export KOVA_OCM_TRANSPORT_JSON
    KOVA_OCM_TRANSPORT_JSON="$(candidate_transport "$OCM_BINARY")"
  fi
  mkdir -p "$report_dir" "$bundle_dir" "$summary_dir"

  local timeout_ms=300000
  [[ "$profile" == release ]] && timeout_ms=900000
  local plan_json="$results/.artifacts/kova/plans/$lane.json"
  mkdir -p "$(dirname "$plan_json")"
  kova matrix plan \
    --profile "$profile" --target "local-build:$openclaw" --include "$include_filters" \
    --parallel 1 --repeat "$repeat" --json > "$plan_json"
  [[ "$admitted" != true ]] || validate_plan "$plan_json" "$profile" "$include_filters" "$expected_entries"
  local args=(
    matrix run --profile "$profile" --target "local-build:$openclaw" --include "$include_filters"
    --parallel 1 --repeat "$repeat" --auth mock --timeout-ms "$timeout_ms"
    --report-dir "$report_dir" --execute --json
  )
  [[ "$lane" != "mock-deep-profile" ]] || args+=(--deep-profile)
  [[ "$fail_on_regression" != true || "$admitted" != true ]] || args+=(--gate)
  local status=0 bundle_status=0
  KOVA_OPENCLAW_CONFIG_CONTRACT="$contract" KOVA_SCENARIO_TIMEOUT_MS="$timeout_ms" \
    kova "${args[@]}" > "$report_dir/$lane.log" 2>&1 || status=$?
  local report
  if [[ "$admitted" == true ]]; then
    report="$(node "$helpers/lib/kova-report-selector.mjs" --report-dir "$report_dir")"
  else
    # Custom Kova and its selection are diagnostics, never the trusted evaluator.
    local candidate reports=()
    for candidate in "$report_dir"/*.json; do
      [[ "$candidate" == *.summary.json ]] || reports+=("$candidate")
    done
    ((${#reports[@]} == 1)) || die "custom Kova must emit one diagnostic report"
    report="${reports[0]}"
  fi
  kova report bundle "$report" \
    --output-dir "$bundle_dir" --json > "$bundle_dir/bundle.json" || bundle_status=$?
  ((bundle_status == 0)) || return "$bundle_status"
  if [[ "$admitted" == true ]]; then
    # Only A can attest a completed matrix phase after setup and bundling succeeded.
    printf '%s\n' "$status" > "$results/.artifacts/kova/$lane-matrix-exit"
    return 0
  fi
  return "$status"
}

validate_plan() {
  node --input-type=module - "$@" <<'NODE'
import fs from "node:fs";
const [file, profile, include, expected] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(file, "utf8"));
const filters = include.split(",");
if (!Array.isArray(plan.controls?.include) ||
    plan.controls.include.length !== filters.length ||
    plan.controls.include.some((filter, index) => filter !== filters[index])) {
  throw new Error("Kova plan did not preserve the requested include filters");
}
if (profile === "release") {
  if (!Array.isArray(plan.entries)) throw new Error("Kova release plan did not contain entries");
  const actual = plan.entries.map((entry) => {
    if (entry.status !== "SELECTED" || !entry.scenario?.id || !entry.state?.id) {
      throw new Error("Kova release plan contained an invalid selected entry");
    }
    return `${entry.scenario.id}:${entry.state.id}`;
  }).sort();
  const required = expected.split(",").sort();
  if (actual.length !== required.length || actual.some((entry, index) => entry !== required[index])) {
    throw new Error("Kova release plan entries did not match the required lane coverage");
  }
}
NODE
}

validate_kova() {
  local lane="$1" root="$2" profile="$3" repeat="$4" include_filters="$5" expected_entries="$6"
  local fail_on_regression="$7" helpers="$8" model="$9" require_instrumented="${10}"
  local results="${11}" status="${12}" admitted="${13}"
  local report_dir="$results/.artifacts/kova/reports/$lane"
  local bundle_dir="$results/.artifacts/kova/bundles/$lane"
  local summary_dir="$results/.artifacts/kova/summaries"
  local plan_json="$results/.artifacts/kova/plans/$lane.json" openclaw="$root/openclaw"
  validate_plan "$plan_json" "$profile" "$include_filters" "$expected_entries"
  local report
  report="$(node "$helpers/lib/kova-report-selector.mjs" --report-dir "$report_dir")"
  local evidence_status=0 summary_status=0 effective_status="$status"
  node "$helpers/lib/kova-workflow-evidence.mjs" \
    --plan "$plan_json" --report "$report" --profile "$profile" \
    --target "local-build:$openclaw" --repeat "$repeat" --include "$include_filters" \
    --auth mock --model "$model" || evidence_status=$?
  if [[ "$admitted" == true && "$evidence_status" == 0 && "$fail_on_regression" == true && "$status" != 0 ]]; then
    local gate_args=("$report")
    [[ "$require_instrumented" != true ]] || gate_args+=(--require-instrumented-performance-contract)
    if node "$helpers/lib/kova-report-gate.mjs" "${gate_args[@]}"; then
      effective_status=0
    fi
  fi
  node "$helpers/kova-ci-summary.mjs" --report "$report" \
    --output "$summary_dir/$lane.md" --lane "$lane" || summary_status=$?
  node --input-type=module - "$report" <<'NODE'
import fs from "node:fs";
const metadata = fs.lstatSync(process.argv[2]);
if (!metadata.isFile() || metadata.size > 50000000) throw new Error("invalid diagnostic report file");
NODE
  ((evidence_status == 0 && summary_status == 0)) ||
    die "Kova evidence, bundle, or summary validation failed"
  [[ -s "$bundle_dir/bundle.json" && -s "$summary_dir/$lane.md" ]] ||
    die "Kova bundle or summary evidence is missing"
  if [[ "$admitted" != true ]]; then
    [[ "$fail_on_regression" != true ]] || die "custom Kova cannot authorize a performance gate"
  fi
  [[ "$fail_on_regression" != true ]] || return "$effective_status"
}

build_source_performance() {
  if [[ -f scripts/build-all.mts ]] &&
    node --import tsx scripts/build-all.mts --help | grep -Fxq '  sourcePerformance'; then
    OPENCLAW_BUILD_PRIVATE_QA=1 node --import tsx scripts/build-all.mts sourcePerformance
  elif [[ -f scripts/build-all.mjs ]] &&
    node scripts/build-all.mjs --help | grep -Fxq '  sourcePerformance'; then
    OPENCLAW_BUILD_PRIVATE_QA=1 node scripts/build-all.mjs sourcePerformance
  else
    pnpm build
  fi
}

source_cli_probes() (
  local openclaw="$1" source_dir="$2" repeat="$3" helpers="$4" supported="$5"
  [[ "$supported" == true || "$supported" == false ]] || die "invalid CLI capability"
  mkdir -p "$source_dir"
  printf '{"supported":%s,"entry":"openclaw.mjs"}\n' "$supported" > "$source_dir/cli-capability.json"
  if [[ "$supported" == false ]]; then
    printf '# OpenClaw Source Performance\n\nTrusted CLI measurement unsupported: the pinned target has no openclaw.mjs entry.\n' > "$source_dir/index.md"
    return
  fi
  local gateway_home gateway_readiness_home gateway_port gateway_token gateway_pid=""
  gateway_home="$(as_candidate mktemp -d)"
  gateway_readiness_home="$(as_candidate mktemp -d)"
  cleanup_gateway() {
    if [[ -n "${gateway_pid:-}" ]] && kill -0 "$gateway_pid" 2>/dev/null; then
      kill "$gateway_pid" 2>/dev/null || true
      wait "$gateway_pid" 2>/dev/null || true
    fi
    as_candidate rm -rf -- "${gateway_home:-}" "${gateway_readiness_home:-}"
  }
  trap cleanup_gateway EXIT
  gateway_port="$(node -e "const net=require('node:net'); const s=net.createServer(); s.listen(0,'127.0.0.1',()=>{ console.log(s.address().port); s.close(); });")"
  gateway_token="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
  local gateway_state="$gateway_home/.openclaw" gateway_config="$gateway_home/.openclaw/openclaw.json"
  local readiness_state="$gateway_readiness_home/.openclaw" readiness_config="$gateway_readiness_home/.openclaw/openclaw.json"
  local gateway_log="$source_dir/cli-gateway.log" readiness_log="$source_dir/cli-gateway-readiness.log"
  as_candidate mkdir -p "$gateway_state" "$readiness_state"
  local catalog_refresh_config=""
  if as_candidate grep -q 'catalogRefresh:' "$openclaw/src/config/zod-schema.core.ts"; then
    catalog_refresh_config='"models": { "catalogRefresh": { "enabled": false } },'
  fi
  as_candidate tee "$gateway_config" >/dev/null <<EOF
{
  "agents": { "defaults": { "heartbeat": { "every": "0m" } } },
  "browser": { "enabled": false },
  ${catalog_refresh_config}
  "update": { "checkOnStart": false },
  "gateway": {
    "mode": "local", "port": ${gateway_port}, "bind": "loopback",
    "auth": { "mode": "token" }, "controlUi": { "enabled": false },
    "tailscale": { "mode": "off" }
  },
  "plugins": { "enabled": true, "entries": { "browser": { "enabled": false } } }
}
EOF
  as_candidate cp "$gateway_config" "$readiness_config"
  as_candidate env OPENCLAW_GATEWAY_TOKEN="$gateway_token" OPENCLAW_HOME="$gateway_home" \
    OPENCLAW_STATE_DIR="$gateway_state" OPENCLAW_CONFIG_PATH="$gateway_config" \
    OPENCLAW_GATEWAY_PORT="$gateway_port" OPENCLAW_SKIP_CHANNELS=1 OPENCLAW_SKIP_CRON=1 \
    node "$openclaw/dist/entry.js" gateway run --bind loopback --port "$gateway_port" --auth token --allow-unconfigured --force \
    > "$gateway_log" 2>&1 &
  gateway_pid="$!"
  local deadline=$((SECONDS + 120)) remaining probe_timeout
  while true; do
    remaining=$((deadline - SECONDS))
    ((remaining > 0)) || die "timed out waiting for gateway HTTP health"
    probe_timeout="$remaining"
    ((probe_timeout <= 5)) || probe_timeout=5
    if curl -fsS --connect-timeout 2 --max-time "$probe_timeout" "http://127.0.0.1:$gateway_port/healthz" >/dev/null; then
      break
    fi
    kill -0 "$gateway_pid" 2>/dev/null || die "gateway exited before HTTP health"
    sleep 1
  done
  while true; do
    remaining=$((deadline - SECONDS))
    ((remaining > 0)) || die "timed out waiting for gateway WebSocket health"
    if as_candidate env OPENCLAW_GATEWAY_TOKEN="$gateway_token" OPENCLAW_HOME="$gateway_readiness_home" \
      OPENCLAW_STATE_DIR="$readiness_state" OPENCLAW_CONFIG_PATH="$readiness_config" \
      node "$openclaw/dist/entry.js" gateway health --port "$gateway_port" --timeout "$((remaining * 1000))" \
      --json > "$readiness_log" 2>&1; then
      break
    fi
    kill -0 "$gateway_pid" 2>/dev/null || die "gateway exited before WebSocket health"
    ((SECONDS >= deadline)) || sleep 1
  done
  OPENCLAW_BENCH_TRANSPORT_JSON="$(candidate_transport "/opt/node-v${NODE_VERSION}/bin/node")" \
    OPENCLAW_GATEWAY_TOKEN="$gateway_token" OPENCLAW_HOME="$gateway_home" \
    OPENCLAW_STATE_DIR="$gateway_state" OPENCLAW_CONFIG_PATH="$gateway_config" \
    OPENCLAW_GATEWAY_PORT="$gateway_port" \
    node "$helpers/bench-cli-startup.mjs" --entry "$openclaw/openclaw.mjs" \
    --case gatewayHealthJsonWarmState --case gatewayHealthJsonFreshState \
    --case configGetGatewayPort --runs "$repeat" --warmup 1 --output "$source_dir/cli-startup.json"
)

collect_diagnostics() {
  local source="$1" destination="$2" subtree="$3"
  local file relative size total=0 count=0
  [[ -d "$source/$subtree" && ! -L "$source/$subtree" ]] || die "diagnostic subtree is missing"
  # B has been stopped. Copy only bounded regular bytes, never a candidate-selected destination.
  while IFS= read -r -d '' file; do
    [[ ! -L "$file" && ( -d "$file" || -f "$file" ) ]] || die "diagnostic links or special files are forbidden"
    [[ "$(as_sut /usr/bin/realpath "$file")" == "$file" ]] || die "diagnostic ancestor is redirected"
    [[ -f "$file" ]] || continue
    relative="${file#"$source/"}"
    [[ "$relative" =~ ^\.artifacts/[A-Za-z0-9._/-]+$ && "$relative" != *"/../"* ]] ||
      die "unsafe diagnostic path"
    case "$relative" in
      .artifacts/openclaw-performance/source/mock-provider/cli-* | \
      .artifacts/openclaw-performance/source/mock-provider/index.md)
        die "candidate diagnostics cannot supply runner measurement files" ;;
    esac
    [[ "$(as_sut /usr/bin/stat -c %h "$file")" == 1 ]] || die "diagnostic hardlinks are forbidden"
    size="$(as_sut /usr/bin/stat -c %s "$file")"
    ((size <= MAX_ARTIFACT_FILE_BYTES)) || die "diagnostic file exceeds byte limit"
    count=$((count + 1)) total=$((total + size))
    ((count <= MAX_ARTIFACT_FILES && total <= MAX_ARTIFACT_BYTES)) || die "diagnostics exceed payload limit"
    [[ ! -e "$destination/$relative" && ! -L "$destination/$relative" ]] ||
      die "diagnostics cannot replace runner output"
    install -D -o "$RUNNER_USER" -g "$RUNNER_USER" -m 0600 "$file" "$destination/$relative"
  done < <(as_sut /usr/bin/find "$source/$subtree" -print0)
  # install -D creates root-owned ancestors; hand them only to A, after B is absent.
  chown -R "$RUNNER_USER:$RUNNER_USER" "$destination/.artifacts"
}

quiesce_sut() {
  local uid deadline
  uid="$(id -u "$SUT_USER")"
  loginctl disable-linger "$SUT_USER"
  systemctl stop "user@${uid}.service"
  pkill -KILL -u "$uid" 2>/dev/null || true
  deadline=$((SECONDS + 20))
  while pgrep -u "$uid" >/dev/null 2>&1; do
    ((SECONDS < deadline)) || die "SUT processes survived termination"
    sleep 1
  done
}

write_payload() {
  local lane="$1" root="$2" control_workspace="$3" tested_ref="$4"
  local openclaw_sha="$5" kova_sha="$6" workflow_sha="$7"
  local run_id="$8" run_attempt="$9" crabbox_commit="${10}" crabbox_version="${11}"
  local started_at="${12}" finished_at="${13}"
  local profile="${14}" repeat="${15}" contract="${16}" include_filters="${17}"
  local fail_on_regression="${18}" workload_status="${19}"
  local output="$control_workspace/.artifacts/performance-crabbox/$lane"
  local manifest="$output/artifacts.jsonl" payload="$output/payload.tar.gz"
  local paths=()

  case "$lane" in
    mock-provider | mock-deep-profile)
      paths=(
        ".artifacts/kova/plans/$lane.json"
        ".artifacts/kova/reports/$lane"
        ".artifacts/kova/bundles/$lane"
        ".artifacts/kova/summaries/$lane.md"
      )
      ;;
    source) paths=(".artifacts/openclaw-performance/source") ;;
    *) die "unsupported payload lane $lane" ;;
  esac

  [[ -d "$output" && ! -L "$output" ]] || die "collector export directory was not prepared"
  : > "$manifest"
  local file_count=0 total_bytes=0 path file rel size sha
  for path in "${paths[@]}"; do
    [[ -e "$root/$path" ]] || die "missing artifact path $path"
    while IFS= read -r -d '' file; do
      [[ ! -L "$file" ]] || die "artifact symlinks are forbidden"
      rel="${file#"$root/"}"
      [[ "$rel" =~ ^\.artifacts/[A-Za-z0-9._/-]+$ && "$rel" != *"/../"* ]] ||
        die "unsafe artifact path"
      [[ "$(as_runner /usr/bin/realpath "$file")" == "$file" ]] || die "artifact symlink ancestors are forbidden"
      size="$(as_runner /usr/bin/stat -c %s "$file")"
      ((size > 0 && size <= MAX_ARTIFACT_FILE_BYTES)) || die "artifact size is out of bounds: $rel"
      sha="$(as_runner /usr/bin/sha256sum "$file" | cut -d' ' -f1)"
      jq -cn --arg path "$rel" --argjson size "$size" --arg sha256 "$sha" \
        '{path:$path,size:$size,sha256:$sha256}' >> "$manifest"
      file_count=$((file_count + 1))
      total_bytes=$((total_bytes + size))
      ((file_count <= MAX_ARTIFACT_FILES && total_bytes <= MAX_ARTIFACT_BYTES)) ||
        die "artifact payload is too large"
    done < <(as_runner /usr/bin/find "$root/$path" -type f -print0 | sort -z)
  done
  ((file_count > 0 && file_count <= MAX_ARTIFACT_FILES)) || die "artifact file count is out of bounds"
  ((total_bytes <= MAX_ARTIFACT_BYTES)) || die "artifact payload is too large"
  jq -sr 'sort_by(.path)' "$manifest" > "$output/artifacts.json"
  jq -jr '.[] | .path + "\u0000"' "$output/artifacts.json" |
    as_runner /usr/bin/tar --dereference -C "$root" -czf - --null --verbatim-files-from -T - > "$payload"

  jq -n \
    --arg lane "$lane" --arg testedRef "$tested_ref" \
    --arg openclawSha "$openclaw_sha" --arg kovaSha "$kova_sha" \
    --arg workflowSha "$workflow_sha" --arg runId "$run_id" --arg runAttempt "$run_attempt" \
    --arg crabboxCommit "$crabbox_commit" --arg crabboxVersion "$crabbox_version" \
    --arg startedAt "$started_at" --arg finishedAt "$finished_at" \
    --arg profile "$profile" --arg repeat "$repeat" --arg contract "$contract" \
    --arg includeFilters "$include_filters" --arg failOnRegression "$fail_on_regression" \
    --argjson exitCode "$workload_status" \
    --slurpfile artifacts "$output/artifacts.json" \
    '{
      schemaVersion:1,lane:$lane,testedRef:$testedRef,openclawSha:$openclawSha,kovaSha:$kovaSha,
      workflow:{sha:$workflowSha,runId:$runId,runAttempt:$runAttempt},
      crabbox:{commit:$crabboxCommit,version:$crabboxVersion},
      command:{
        name:$lane,
        argv:["profile="+$profile,"repeat="+$repeat,"contract="+$contract,
          "include="+$includeFilters,"failOnRegression="+$failOnRegression],
        exitCode:$exitCode,startedAt:$startedAt,finishedAt:$finishedAt
      },
      isolation:{
        sutUser:"openclaw-sut",trustedHarnessRootOwned:true,noSudo:true,
        imdsBlocked:true,environmentClean:true,cachesEmptyBefore:true,
        tailscaleRequested:false,tailscaleMetadataAbsent:true
      },
      artifacts:$artifacts[0],
      lease:{provider:"aws",market:"on-demand",cleanupPolicy:"always"}
    }' > "$output/remote-evidence.json"
  rm -f "$manifest" "$output/artifacts.json"
  chmod 0644 "$payload" "$output/remote-evidence.json"
}

remote_main() {
  (($# == 17)) || die "remote mode requires 17 arguments"
  local lane="$1" openclaw_sha="$2" kova_sha="$3" workflow_sha="$4" tested_ref="$5"
  local profile="$6" repeat="$7" contract="$8" include_filters="$9"
  local expected_entries="${10}" fail_on_regression="${11}" run_id="${12}" run_attempt="${13}"
  local crabbox_version="${14}"
  local model="${15}" require_instrumented="${16}"
  local admitted_kova_sha="${17}"
  case "$lane" in
    source | mock-provider | mock-deep-profile) ;;
    *) die "unsupported lane $lane" ;;
  esac
  require_sha openclaw_sha "$openclaw_sha"
  require_sha kova_sha "$kova_sha"
  require_sha workflow_sha "$workflow_sha"
  require_sha admitted_kova_sha "$admitted_kova_sha"
  require_scalar tested_ref "$tested_ref"
  require_scalar crabbox_version "$crabbox_version"
  require_scalar model "$model"
  [[ "$require_instrumented" == true || "$require_instrumented" == false ]] ||
    die "instrumented contract requirement must be boolean"
  [[ "$repeat" =~ ^[1-9][0-9]*$ ]] || die "repeat must be positive"

  if ((EUID != 0)); then
    local self_sha root_script control_workspace
    self_sha="$(sha256sum "$0" | cut -d' ' -f1)"
    root_script="/usr/local/libexec/openclaw-performance-${self_sha}.sh"
    control_workspace="$(dirname "$(dirname "$(dirname "$(realpath "$0")")")")"
    [[ -d "$control_workspace/.crabbox/scripts" ]] || die "Crabbox workspace is invalid"
    [[ "${CRABBOX_LEASE_ID:-}" =~ ^cbx_[0-9a-f]{12}$ &&
      "$control_workspace" == "/work/crabbox/$CRABBOX_LEASE_ID/openclaw" ]] ||
      die "expected dedicated raw workspace"
    local hydration="$HOME/.crabbox/actions/$CRABBOX_LEASE_ID.env"
    [[ ! -e "$hydration" && ! -L "$hydration" ]] || die "hydrated workspace is forbidden"
    # The SSH collector must own each private ancestor before root writes the payload.
    local path status=0
    for path in .artifacts .artifacts/performance-crabbox ".artifacts/performance-crabbox/$lane"; do
      [[ ! -L "$control_workspace/$path" ]] || die "collector export path is a symlink"
      install -d -m 0700 "$control_workspace/$path"
    done
    [[ ! -e "$control_workspace/.artifacts/performance-crabbox/$lane/workload-result.json" ]] ||
      die "workload receipt already exists"
    sudo /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /bin/bash -c \
      'install -D -o root -g root -m 0755 "$1" "$2"; workspace=$3; shift 3; cd "$workspace"; exec "$0" "$@"' \
      "$root_script" "$0" "$root_script" "$control_workspace" remote "$@" || status=$?
    # Always terminate candidate output with the collector's own result, including null on failure.
    local receipt="$control_workspace/.artifacts/performance-crabbox/$lane/workload-result.json" result=null
    if [[ -f "$receipt" && ! -L "$receipt" &&
      "$(stat -c '%u:%g:%a' "$receipt")" == "0:0:644" &&
      ! -e "$hydration" && ! -L "$hydration" ]]; then
      result="$(jq -c --arg workspace "$control_workspace" --arg runId "$CRABBOX_RUN_ID" \
        '. + {workspace:$workspace,runId:$runId,noHydration:true}' "$receipt")"
    fi
    printf 'performance-result %s\n' "$result"
    return "$status"
  fi
  [[ "$0" == /usr/local/libexec/openclaw-performance-*.sh ]] || die "root harness is not installed"
  [[ "$(stat -c '%U:%G:%a' "$0")" == "root:root:755" ]] || die "root harness ownership is invalid"
  local installed_hash="${0##*/openclaw-performance-}"
  installed_hash="${installed_hash%.sh}"
  [[ "$(sha256sum "$0" | cut -d' ' -f1)" == "$installed_hash" ]] || die "root harness hash is invalid"

  local control_workspace="$PWD" root="/srv/openclaw-performance" started_at finished_at status
  rm -rf "$root"
  install -d -m 0755 "$root"
  install_toolchain
  local helpers="/usr/local/libexec/openclaw-performance-helpers"
  local helper
  for helper in lib/kova-report-selector.mjs lib/kova-workflow-evidence.mjs \
    lib/kova-report-gate.mjs kova-ci-summary.mjs bench-cli-startup.mjs \
    openclaw-performance-source-summary.mjs; do
    install -D -o root -g root -m 0644 \
      "$control_workspace/.github/crabbox/performance-control/helpers/$helper" "$helpers/$helper"
  done
  prepare_sut
  prepare_runner
  clone_exact openclaw/openclaw "$openclaw_sha" "$root/openclaw" "$SUT_USER"
  local admitted=false kova="$root/kova" executor=as_sut
  local results="/home/${RUNNER_USER}/results" workload_results="$root/openclaw"
  if [[ "$kova_sha" == "$admitted_kova_sha" ]]; then
    admitted=true kova="/home/${RUNNER_USER}/kova" executor=as_runner
    workload_results="$results"
  fi
  clone_exact openclaw/Kova "$kova_sha" "$kova" "$([[ "$admitted" == true ]] && echo "$RUNNER_USER" || echo "$SUT_USER")"

  local source_cli_supported=false source_cli_entry
  if [[ "$lane" == source ]]; then
    # Capture immutable entry availability before any candidate lifecycle code runs.
    source_cli_entry="$(as_sut /usr/bin/git -C "$root/openclaw" ls-tree --name-only "$openclaw_sha" -- openclaw.mjs)"
    case "$source_cli_entry" in
      openclaw.mjs) source_cli_supported=true ;;
      "") ;;
      *) die "unexpected CLI entry inventory" ;;
    esac
  fi
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  set +e
  (
    set -e
    as_sut "$0" __prepare "$root"
    if [[ "$lane" == source ]]; then
      [[ "$source_cli_supported" != true ]] || as_sut "$0" __build "$root/openclaw"
      source_status=0
      as_sut "$0" __sut "$lane" "$root" "$profile" "$repeat" "$contract" "$include_filters" \
        "$expected_entries" false "$helpers" "$model" "$require_instrumented" "$workload_results" "$kova" false || source_status=$?
      as_runner "$0" __source-cli "$root/openclaw" \
        "$results/.artifacts/openclaw-performance/source/mock-provider" "$repeat" "$helpers" "$source_cli_supported"
      exit "$source_status"
    else
      as_sut "$0" __build "$root/openclaw"
      "$executor" "$0" __sut "$lane" "$root" "$profile" "$repeat" "$contract" "$include_filters" \
        "$expected_entries" "$fail_on_regression" "$helpers" "$model" "$require_instrumented" "$workload_results" "$kova" "$admitted"
    fi
  )
  status=$?
  set -e
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  quiesce_sut
  [[ "$(as_sut /usr/bin/git -C "$root/openclaw" rev-parse HEAD)" == "$openclaw_sha" ]] ||
    die "OpenClaw HEAD changed during SUT execution"
  [[ "$("$executor" /usr/bin/git -C "$kova" rev-parse HEAD)" == "$kova_sha" ]] ||
    die "Kova HEAD changed during SUT execution"

  if [[ "$lane" == source ]]; then
    local source_status
    set +e
    (
      set -e
      collect_diagnostics "$root/openclaw" "$results" ".artifacts/openclaw-performance/source"
      if [[ "$source_cli_supported" == true ]]; then
        as_runner node "$helpers/openclaw-performance-source-summary.mjs" \
          --source-dir "$results/.artifacts/openclaw-performance/source/mock-provider" \
          --output "$results/.artifacts/openclaw-performance/source/mock-provider/index.md"
      fi
    )
    source_status=$?
    set -e
    if ((status == 0)); then status="$source_status"; fi
  elif [[ "$admitted" != true ]]; then
    local finalization_status
    set +e
    (
      set -e
      collect_diagnostics "$root/openclaw" "$results" ".artifacts/kova"
      local validation_status=0
      as_runner "$0" __validate-kova "$lane" "$root" "$profile" "$repeat" "$include_filters" \
        "$expected_entries" "$fail_on_regression" "$helpers" "$model" "$require_instrumented" \
        "$results" "$status" "$admitted" || validation_status=$?
      as_runner /bin/sh -eu -c '
        mkdir -p "$(dirname "$1")"
        printf "\nCustom Kova: candidate-produced diagnostics only; not gate evidence.\n" >> "$1"
      ' sh "$results/.artifacts/kova/summaries/$lane.md"
      exit "$validation_status"
    )
    finalization_status=$?
    set -e
    if ((status == 0)); then status="$finalization_status"; fi
  else
    local validation_status=0 matrix_status="$status"
    if [[ "$status" == 0 ]]; then
      local matrix_receipt="$results/.artifacts/kova/$lane-matrix-exit" matrix_receipt_size
      matrix_receipt_size="$(as_runner /usr/bin/stat -c %s "$matrix_receipt")"
      ((matrix_receipt_size >= 2 && matrix_receipt_size <= 4)) || die "invalid matrix phase receipt size"
      matrix_status="$(as_runner /usr/bin/cat "$matrix_receipt")"
      [[ "$matrix_status" =~ ^(0|[1-9][0-9]{0,2})$ && "$matrix_status" -le 255 ]] ||
        die "invalid matrix phase exit"
    fi
    as_runner "$0" __validate-kova "$lane" "$root" "$profile" "$repeat" "$include_filters" \
      "$expected_entries" "$fail_on_regression" "$helpers" "$model" "$require_instrumented" \
      "$results" "$matrix_status" "$admitted" || validation_status=$?
    if ((status == 0)); then status="$validation_status"; fi
  fi
  local export_status
  set +e
  (
    set -e
    write_payload "$lane" "$results" "$control_workspace" "$tested_ref" "$openclaw_sha" "$kova_sha" \
    "$workflow_sha" "$run_id" "$run_attempt" "$CRABBOX_COMMIT" "$crabbox_version" \
    "$started_at" "$finished_at" "$profile" "$repeat" "$contract" "$include_filters" \
    "$fail_on_regression" "$status"
  )
  export_status=$?
  set -e
  local receipt="$control_workspace/.artifacts/performance-crabbox/$lane/workload-result.json"
  jq -n --argjson exitCode "$status" --argjson exportExitCode "$export_status" \
    --arg startedAt "$started_at" --arg finishedAt "$finished_at" \
    '{exitCode:$exitCode,exportExitCode:$exportExitCode,startedAt:$startedAt,finishedAt:$finishedAt}' > "$receipt"
  chmod 0644 "$receipt"
  ((status == 0)) || return "$status"
  return "$export_status"
}

verify_payload() {
  (($# == 7)) || die "verify mode requires lane, timing, lease, evidence, payload, output, and expectations"
  local lane="$1" timing="$2" lease_id="$3" evidence="$4" payload="$5" output="$6"
  local expected="$7"
  local tmp
  tmp="$(mktemp -d)"
  VERIFY_TMP="$tmp"
  trap 'rm -rf -- "$VERIFY_TMP"' EXIT

  jq -e --arg id "$lease_id" --slurpfile expected "$expected" \
    '.provider == "aws" and .leaseId == $id and . == $expected[0].timing and
      $expected[0].stopped == true' "$timing" >/dev/null ||
    die "Crabbox timing did not bind the expected lease"
  jq -e --arg lane "$lane" --slurpfile expected "$expected" \
    '. as $e | $expected[0] as $x |
      .schemaVersion == 1 and .lane == $lane and
      all(["testedRef","openclawSha","kovaSha","workflow","crabbox","command"][]; $e[.] == $x[.]) and
      (.artifacts | length > 0 and length <= 256) and
      (.artifacts | map(.path) | length == (unique | length)) and
      all(.artifacts[]; (.size > 0 and .size <= 50000000) and
        (.path | test("^\\.artifacts/[A-Za-z0-9._/-]+$")) and
        (.path | split("/") | all(. != ".." and . != "."))) and
      ([.artifacts[].size] | add <= 250000000)' \
    "$evidence" >/dev/null || die "remote evidence is invalid"

  tar -tzf "$payload" > "$tmp/tar-paths"
  grep -Ev '^\.artifacts/[A-Za-z0-9._/-]+$' "$tmp/tar-paths" > "$tmp/unsafe" || true
  [[ ! -s "$tmp/unsafe" ]] || die "payload contains unsafe paths"
  jq -r '.artifacts[].path' "$evidence" > "$tmp/evidence-paths"
  diff -u "$tmp/evidence-paths" "$tmp/tar-paths"
  tar -xzf "$payload" -C "$tmp"

  while IFS=$'\t' read -r path size sha; do
    [[ -f "$tmp/$path" && ! -L "$tmp/$path" ]] || die "payload file missing: $path"
    [[ "$(file_size "$tmp/$path")" == "$size" ]] || die "payload size mismatch: $path"
    [[ "$(file_sha256 "$tmp/$path")" == "$sha" ]] ||
      die "payload hash mismatch: $path"
  done < <(jq -r '.artifacts[] | [.path,.size,.sha256] | @tsv' "$evidence")

  mkdir -p "$(dirname "$output")" .artifacts
  cp -R "$tmp/.artifacts/." .artifacts/
  jq --arg leaseId "$lease_id" \
    '.lease += {id:$leaseId,stopped:true,stopError:""}' "$evidence" > "$output"
  jq -e --arg lane "$lane" --arg id "$lease_id" \
    '.schemaVersion == 1 and .lane == $lane and .lease.id == $id and .lease.stopped == true and
      .lease.stopError == ""' "$output" >/dev/null ||
    die "final evidence is invalid"
}

confirm_stop() {
  (($# == 2)) || die "confirm-stop requires Crabbox path and lease id"
  [[ -x "$1" && "$2" =~ ^cbx_[0-9a-f]{12}$ ]] || die "invalid explicit stop request"
  "$1" stop --provider aws --id "$2" >/dev/null 2>&1
}

case "${1:-}" in
  build-helpers)
    build_helpers
    ;;
  remote)
    shift
    remote_main "$@"
    ;;
  __sut)
    shift
    run_sut "$@"
    ;;
  __prepare)
    shift
    prepare_candidate "$@"
    ;;
  __build)
    cd "$2"
    build_source_performance
    ;;
  __source-cli)
    shift
    source_cli_probes "$@"
    ;;
  __candidate-id)
    as_candidate id -u
    ;;
  __validate-kova)
    shift
    validate_kova "$@"
    ;;
  verify)
    shift
    verify_payload "$@"
    ;;
  confirm-stop)
    shift
    confirm_stop "$@"
    ;;
  *)
    die "usage: $0 build-helpers|remote|verify|confirm-stop ..."
    ;;
esac
