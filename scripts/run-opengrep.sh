#!/usr/bin/env bash
# scripts/run-opengrep.sh
#
# Run the openclaw opengrep rulepack against the local working tree using the
# same paths and exclusions as CI. The .semgrepignore at the repo root is the
# single source of truth for which paths are skipped — both this script and
# .github/workflows/opengrep-{precise,broad}.yml rely on it.
#
# Usage:
#   scripts/run-opengrep.sh                      # precise (default), human output
#   scripts/run-opengrep.sh precise              # same
#   scripts/run-opengrep.sh broad                # broad review-aid rules
#   scripts/run-opengrep.sh precise --sarif      # write SARIF for upload/triage
#   scripts/run-opengrep.sh precise --json       # write JSON for ad-hoc parsing
#
# Optional positional path overrides come last:
#   scripts/run-opengrep.sh precise -- src/agents/   # scan a single dir
#
# Exit code: 0 on success regardless of findings (matches CI's
# `continue-on-error: true`). Use --error to flip to non-zero on findings.

set -euo pipefail

BUCKET="${1:-precise}"
shift || true

case "$BUCKET" in
  precise|broad) ;;
  -h|--help)
    sed -n '2,22p' "$0"
    exit 0
    ;;
  *)
    echo "error: unknown bucket '$BUCKET' (expected 'precise' or 'broad')" >&2
    exit 64
    ;;
esac

# Resolve repo root from this script's location so the command works from any cwd.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$REPO_ROOT/security/opengrep/$BUCKET.yml"

if [[ ! -f "$CONFIG" ]]; then
  echo "error: rulepack not found at $CONFIG" >&2
  echo "Recompile with: node scripts/compile-opengrep-rules.mjs --run-dir <run> --out-dir security/opengrep" >&2
  exit 66
fi

if ! command -v opengrep >/dev/null 2>&1; then
  cat >&2 <<'EOF'
error: 'opengrep' not found on PATH.

Install with one of:
  curl -fsSL https://raw.githubusercontent.com/opengrep/opengrep/v1.19.0/install.sh | bash -s -- -v v1.19.0
  brew install opengrep/tap/opengrep
  pipx install opengrep

(See https://opengrep.dev for other options.)
EOF
  exit 127
fi

# Pull off our own flags from the remaining args; pass everything else through to opengrep.
EXTRA_ARGS=()
PATHS_PASSED=0
SAW_DOUBLE_DASH=0
while (( $# > 0 )); do
  case "$1" in
    --sarif)
      mkdir -p "$REPO_ROOT/.opengrep-out"
      EXTRA_ARGS+=( "--sarif-output=$REPO_ROOT/.opengrep-out/$BUCKET.sarif" )
      shift
      ;;
    --json)
      mkdir -p "$REPO_ROOT/.opengrep-out"
      EXTRA_ARGS+=( "--json" "--output=$REPO_ROOT/.opengrep-out/$BUCKET.json" )
      shift
      ;;
    --)
      SAW_DOUBLE_DASH=1
      shift
      ;;
    *)
      if (( SAW_DOUBLE_DASH )); then
        # Treat anything after `--` as a path-positional override
        if (( PATHS_PASSED == 0 )); then
          PATHS_PASSED=1
          EXTRA_ARGS+=( "$1" )
        else
          EXTRA_ARGS+=( "$1" )
        fi
      else
        EXTRA_ARGS+=( "$1" )
      fi
      shift
      ;;
  esac
done

# Default scan paths match the CI workflows. Override by passing `-- <paths...>`.
if (( PATHS_PASSED == 0 )); then
  SCAN_PATHS=( "src/" "extensions/" "apps/" "packages/" "scripts/" )
else
  SCAN_PATHS=()
fi

cd "$REPO_ROOT"
echo "→ Running opengrep ($BUCKET) against $(IFS=' '; echo "${SCAN_PATHS[*]:-overridden}")" >&2
echo "  Using exclusions from .semgrepignore" >&2
exec opengrep scan \
  --no-strict \
  --config "$CONFIG" \
  --no-git-ignore \
  "${EXTRA_ARGS[@]}" \
  "${SCAN_PATHS[@]}"
