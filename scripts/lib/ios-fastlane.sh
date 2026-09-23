#!/bin/bash

# BASH_SOURCE may be relative, so resolve it before callers change directories.
_OPENCLAW_IOS_FASTLANE_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"

parse_ios_release_args() {
  local mode="$1"
  shift

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --build-number|--revision|--version|--team-id)
        if [[ "$1" == --team-id && "$mode" != prepare ]]; then
          break
        fi
        if [[ -z "${2-}" || "${2-}" == --* ]]; then
          echo "Missing value for $1." >&2
          usage >&2
          exit 1
        fi
        case "$1" in
          --build-number) BUILD_NUMBER="$2" ;;
          --revision) APP_STORE_REVISION="$2" ;;
          --version) RELEASE_VERSION="$2" ;;
          --team-id) TEAM_ID="$2" ;;
        esac
        shift 2
        ;;
      --|--json)
        if [[ "$1" == --json && "$mode" != plan ]]; then
          break
        fi
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        break
        ;;
    esac
  done
  if [[ $# -gt 0 ]]; then
    echo "Unknown argument: $1" >&2
    if [[ "$mode" == plan ]]; then
      usage >&2
    else
      usage
    fi
    exit 1
  fi
}

run_ios_fastlane() {
  local gemfile=""
  gemfile="${_OPENCLAW_IOS_FASTLANE_REPO_ROOT}/apps/ios/Gemfile"

  local setup_hint=""
  setup_hint="Install Ruby 3.4.10, then run: cd apps/ios && gem install bundler -v 2.6.9 && bundle _2.6.9_ install"
  if [[ ! -f "$gemfile" ]]; then
    echo "The repository iOS Gemfile is missing at ${gemfile}. Restore it from the repository checkout." >&2
    echo "$setup_hint" >&2
    return 1
  fi
  if ! command -v bundle >/dev/null 2>&1; then
    echo "bundle not found for the iOS Fastlane bundle at ${gemfile}." >&2
    echo "$setup_hint" >&2
    return 127
  fi
  if ! BUNDLE_GEMFILE="$gemfile" bundle _2.6.9_ check >/dev/null 2>&1; then
    echo "The iOS Fastlane bundle is not installed for ${gemfile}." >&2
    echo "$setup_hint" >&2
    return 1
  fi
  BUNDLE_GEMFILE="$gemfile" bundle _2.6.9_ exec fastlane "$@"
}
