#!/usr/bin/env bash

resolve_upgrade_survivor_paths() {
  ARTIFACT_ROOT="$(dirname "${OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON:-/tmp/openclaw-upgrade-survivor-artifacts/summary.json}")"
  RUNTIME_ROOT="${OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT:-/tmp/openclaw-upgrade-survivor-runtime}"
  SUMMARY_JSON="${OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON:-$ARTIFACT_ROOT/summary.json}"
  case "${OPENCLAW_UPGRADE_SURVIVOR_SCENARIO:-base}" in
    base|legacy-operator-state|missing-load-path) npm_config_prefix="$RUNTIME_ROOT/npm-prefix" ;;
    *) npm_config_prefix="$ARTIFACT_ROOT/npm-prefix" ;;
  esac
  BASELINE_PACKAGE_ROOT="$npm_config_prefix/lib/node_modules/openclaw"
  BASELINE_BIN_DIR="$npm_config_prefix/bin"
  BASELINE_INSTALL_LOG="$ARTIFACT_ROOT/baseline-install.log"
  UPDATE_JSON="$ARTIFACT_ROOT/update.json"
  UPDATE_ERR="$ARTIFACT_ROOT/update.err"
  export OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT="$ARTIFACT_ROOT"
  export OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT="$RUNTIME_ROOT"
  export npm_config_prefix NPM_CONFIG_PREFIX="$npm_config_prefix"
}
