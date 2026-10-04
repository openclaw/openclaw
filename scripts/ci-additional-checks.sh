#!/usr/bin/env bash
set -euo pipefail

failures=0

run_check() {
  local label="$1"
  shift

  echo "::group::${label}"
  if "$@"; then
    echo "[ok] ${label}"
  else
    echo "::error title=${label} failed::${label} failed"
    failures=1
  fi
  echo "::endgroup::"
}

check_groups=("$ADDITIONAL_CHECK_GROUP")
if [[ "$ADDITIONAL_CHECK_GROUP" == "source-contracts" ]]; then
  check_groups=(export-name-collisions session-accessor-boundary sqlite-session-schema-baseline)
fi
# Keep fresh, serial child processes and collect every command failure.
for check_group in "${check_groups[@]}"; do
  case "$check_group" in
    boundaries)
      boundary_runner=(node --import tsx scripts/run-additional-boundary-checks.mts)
      if [[ ! -f scripts/run-additional-boundary-checks.mts ]]; then
        boundary_runner=(node scripts/run-additional-boundary-checks.mjs)
      fi
      if [[ "$TYPE_GRAPH_BOUNDARY_OWNER" == "check-plan" || ( -z "$TYPE_GRAPH_BOUNDARY_OWNER" && -n "${CHANGED_CORE_TEST_PATHS_JSON:-}" ) ]]; then
        boundary_runner+=(--core-test-boundary-owner=test-types)
      fi
      "${boundary_runner[@]}"
      ;;
    prompt-snapshots)
      # No presence fallback: the boundary runner previously invoked
      # this unconditionally, and silent success would drop snapshot
      # drift coverage. The manifest gates the lane on the generator's
      # import graph and fixtures; diffs outside both cannot change
      # generated snapshots.
      if [ "$RUN_PROMPT_SNAPSHOTS" != "true" ]; then
        echo "[skip] changed scope cannot affect generated prompt snapshots"
      else
        run_check "prompt:snapshots:check" pnpm prompt:snapshots:check
      fi
      ;;
    export-name-collisions)
      if [ ! -f scripts/check-export-name-collisions.mts ]; then
        echo "[skip] export name collision check is not present in this checkout"
      elif ! node -e 'const pkg = require("./package.json"); process.exit(pkg.scripts?.["lint:tmp:export-name-collisions"] ? 0 : 1);'; then
        echo "[skip] export name collision script is not present in package.json"
      else
        run_check "lint:tmp:export-name-collisions" pnpm run lint:tmp:export-name-collisions
      fi
      ;;
    session-accessor-boundary)
      if ! node -e 'const pkg = require("./package.json"); process.exit(pkg.scripts?.["lint:tmp:session-accessor-boundary"] ? 0 : 1);'; then
        echo "[skip] session accessor boundary script is not present in package.json"
      else
        run_check "lint:tmp:session-accessor-boundary" pnpm run lint:tmp:session-accessor-boundary
      fi
      if ! node -e 'const pkg = require("./package.json"); process.exit(pkg.scripts?.["lint:tmp:sqlite-transaction-boundary"] ? 0 : 1);'; then
        echo "[skip] SQLite transaction boundary script is not present in package.json"
      else
        run_check "lint:tmp:sqlite-transaction-boundary" pnpm run lint:tmp:sqlite-transaction-boundary
      fi
      if ! node -e 'const pkg = require("./package.json"); process.exit(pkg.scripts?.["lint:tmp:session-transcript-reader-boundary"] ? 0 : 1);'; then
        echo "[skip] session transcript reader boundary script is not present in package.json"
      else
        run_check "lint:tmp:session-transcript-reader-boundary" pnpm run lint:tmp:session-transcript-reader-boundary
      fi
      ;;
    sqlite-session-schema-baseline)
      if ! node -e 'const pkg = require("./package.json"); process.exit(pkg.scripts?.["sqlite:sessions-schema:check"] ? 0 : 1);'; then
        echo "[skip] SQLite sessions/transcripts schema baseline script is not present in package.json"
      else
        run_check "sqlite:sessions-schema:check" pnpm run sqlite:sessions-schema:check
      fi
      ;;
    plugin-sdk-api-diff)
      # Pure reporting: no caller passes --require-acknowledgement, so
      # this can only surface an artifact/summary. Keep it off the
      # push/PR critical path; dispatch (incl. release validation)
      # still produces the report.
      if [[ "${GITHUB_EVENT_NAME:-}" != "workflow_dispatch" ]]; then
        echo "[skip] plugin SDK API diff reports on manual and release dispatches only"
      elif node -e 'const pkg = require("./package.json"); process.exit(pkg.scripts?.["plugin-sdk:api:diff"] ? 0 : 1);'; then
        mkdir -p .artifacts
        run_check "plugin-sdk:api:diff" pnpm run plugin-sdk:api:diff -- \
          --base "${SDK_DIFF_BASE}" \
          --head "${SDK_DIFF_HEAD}" \
          --json .artifacts/plugin-sdk-api-diff.json \
          --summary "$GITHUB_STEP_SUMMARY"
      elif [[ "$COMPATIBILITY_TARGET" == "true" ]] && node -e 'const pkg = require("./package.json"); process.exit(pkg.scripts?.["plugin-sdk:api:check"] ? 0 : 1);'; then
        run_check "plugin-sdk:api:check (historical compatibility)" pnpm run plugin-sdk:api:check
      elif [[ "$COMPATIBILITY_TARGET" == "true" ]]; then
        echo "::error title=Plugin SDK API check unavailable::Compatibility target provides neither plugin-sdk:api:diff nor plugin-sdk:api:check."
        failures=1
      else
        echo "::error title=Plugin SDK API diff unavailable::Current CI targets must provide plugin-sdk:api:diff."
        failures=1
      fi
      ;;
    extension-package-boundary)
      run_check "test:extensions:package-boundary:compile" pnpm run test:extensions:package-boundary:compile
      run_check "test:extensions:package-boundary:canary" pnpm run test:extensions:package-boundary:canary
      ;;
    runtime-topology-architecture)
      GOGC="${GOGC:-30}" GOMEMLIMIT="${GOMEMLIMIT:-3GiB}" \
        run_check "check:architecture" pnpm check:architecture
      ;;
    *)
      echo "Unsupported additional check group: $ADDITIONAL_CHECK_GROUP" >&2
      exit 1
      ;;
  esac
done

exit "$failures"
