#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/ops/candidate-npm-upgrade.sh [options]

Installs an OpenClaw baseline package into a temporary npm prefix, runs that
candidate's updater to the target spec, and writes a JSON proof bundle without
touching the live global package prefix or systemd service.

Options:
  --baseline <npm-spec>   Baseline package spec (default: openclaw@2026.4.5)
  --target <npm-spec>     Target package spec/tag/version (default: 2026.4.23)
  --expected <version>    Expected final package version (default: 2026.4.23)
  --keep                  Keep the temporary candidate root after success/fail
  --out <path>            Proof JSON path (default: .artifacts/candidate-npm-upgrade/proof.json)
  -h, --help              Show this help

Environment:
  OPENCLAW_CANDIDATE_NPM       npm binary to use (default: npm)
  OPENCLAW_CANDIDATE_NODE      node binary to use (default: node)
  OPENCLAW_CANDIDATE_TIMEOUT   openclaw update timeout ms (default: 180000)
USAGE
}

baseline="openclaw@2026.4.5"
target="2026.4.23"
expected="2026.4.23"
keep=0
out=".artifacts/candidate-npm-upgrade/proof.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --baseline)
      baseline="${2:?missing --baseline value}"
      shift 2
      ;;
    --target)
      target="${2:?missing --target value}"
      shift 2
      ;;
    --expected)
      expected="${2:?missing --expected value}"
      shift 2
      ;;
    --keep)
      keep=1
      shift
      ;;
    --out)
      out="${2:?missing --out value}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

npm_bin="${OPENCLAW_CANDIDATE_NPM:-npm}"
node_bin="${OPENCLAW_CANDIDATE_NODE:-node}"
update_timeout="${OPENCLAW_CANDIDATE_TIMEOUT:-180000}"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
if [[ "$out" != /* ]]; then
  out="$repo_root/$out"
fi
mkdir -p "$(dirname "$out")"

candidate_root="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-candidate-upgrade-XXXXXX")"
cleanup() {
  if [[ "$keep" != "1" ]]; then
    chmod -R u+w "$candidate_root" 2>/dev/null || true
    rm -rf "$candidate_root" 2>/dev/null || true
  fi
}
trap cleanup EXIT

candidate_prefix="$candidate_root/npm-prefix"
candidate_home="$candidate_root/home"
mkdir -p "$candidate_prefix" "$candidate_home/.openclaw"

candidate_port="$((28000 + RANDOM % 10000))"
cat > "$candidate_home/.openclaw/openclaw.json" <<JSON
{
  "gateway": {
    "mode": "local",
    "port": $candidate_port,
    "controlUi": { "enabled": false }
  },
  "plugins": { "enabled": false },
  "update": { "checkOnStart": false, "auto": { "enabled": false } }
}
JSON

live_openclaw="$(command -v openclaw || true)"
live_prefix="$("$npm_bin" config get prefix 2>/dev/null || true)"
live_version_before=""
if [[ -n "$live_openclaw" ]]; then
  live_version_before="$(openclaw --version 2>/dev/null || true)"
fi

export npm_config_prefix="$candidate_prefix"
export OPENCLAW_HOME="$candidate_home"
export OPENCLAW_DISABLE_BUNDLED_PLUGINS=1
export PATH="$candidate_prefix/bin:$PATH"

printf '==> Candidate root: %s\n' "$candidate_root"
printf '==> Installing baseline: %s\n' "$baseline"
"$npm_bin" install -g "$baseline" --no-audit --no-fund --loglevel=error

candidate_bin="$candidate_prefix/bin/openclaw"
if [[ ! -x "$candidate_bin" ]]; then
  echo "candidate openclaw binary missing: $candidate_bin" >&2
  exit 1
fi

before_version="$($candidate_bin --version | head -n 1)"
printf '==> Baseline candidate: %s\n' "$before_version"
printf '==> Updating candidate to: %s\n' "$target"

update_json="$candidate_root/update.json"
set +e
"$candidate_bin" update --tag "$target" --json --timeout "$update_timeout" >"$update_json" 2>"$candidate_root/update.stderr"
update_code=$?
set -e
if [[ "$update_code" -ne 0 ]]; then
  echo "candidate update failed with exit code $update_code" >&2
  tail -n 80 "$candidate_root/update.stderr" >&2 || true
  exit "$update_code"
fi

after_version="$($candidate_bin --version | head -n 1)"
actual="$($node_bin -e 'const path=process.env.npm_config_prefix+"/lib/node_modules/openclaw/package.json"; console.log(require(path).version)')"
package_root="$candidate_prefix/lib/node_modules/openclaw"

if [[ "$actual" != "$expected" ]]; then
  echo "candidate version mismatch: expected $expected, got $actual" >&2
  exit 1
fi

case "$package_root" in
  "$candidate_root"/*) ;;
  *)
    echo "candidate package root escaped candidate root: $package_root" >&2
    exit 1
    ;;
esac

live_version_after=""
if [[ -n "$live_openclaw" ]]; then
  live_version_after="$("$live_openclaw" --version 2>/dev/null || true)"
fi

"$node_bin" - "$out" "$candidate_root" "$candidate_prefix" "$candidate_home" "$baseline" "$target" "$expected" "$before_version" "$after_version" "$actual" "$package_root" "$live_openclaw" "$live_prefix" "$live_version_before" "$live_version_after" "$update_json" <<'NODE'
const fs = require('node:fs');
const [out, candidateRoot, candidatePrefix, candidateHome, baseline, target, expected, beforeVersion, afterVersion, actualVersion, packageRoot, liveOpenclaw, livePrefix, liveVersionBefore, liveVersionAfter, updateJsonPath] = process.argv.slice(2);
const update = JSON.parse(fs.readFileSync(updateJsonPath, 'utf8'));
const proof = {
  status: 'ok',
  generatedAt: new Date().toISOString(),
  baseline,
  target,
  expectedVersion: expected,
  actualVersion,
  beforeVersion,
  afterVersion,
  candidate: {
    root: candidateRoot,
    npmPrefix: candidatePrefix,
    openclawHome: candidateHome,
    packageRoot,
  },
  live: {
    openclawPath: liveOpenclaw || null,
    npmPrefix: livePrefix || null,
    versionBefore: liveVersionBefore || null,
    versionAfter: liveVersionAfter || null,
    unchanged: liveVersionBefore === liveVersionAfter,
  },
  update,
};
fs.writeFileSync(out, `${JSON.stringify(proof, null, 2)}\n`);
NODE

printf '==> Proof written: %s\n' "$out"
printf '==> Candidate upgraded: %s -> %s\n' "$before_version" "$after_version"
printf '==> Live openclaw unchanged: %s\n' "${live_version_before:-not found}"
