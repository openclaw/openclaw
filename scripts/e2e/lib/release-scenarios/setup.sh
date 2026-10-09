#!/usr/bin/env bash

openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
openclaw_e2e_install_trash_shim

export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export npm_config_loglevel=error
export npm_config_fund=false
export npm_config_audit=false

# The same ordered inventory defines artifact paths and failure diagnostics.
openclaw_release_scenario_logs() {
  OPENCLAW_RELEASE_DIAGNOSTIC_LOGS=()
  while [ "$#" -gt 0 ]; do
    printf -v "$1" '%s' "$2"
    OPENCLAW_RELEASE_DIAGNOSTIC_LOGS+=("$2")
    shift 2
  done
}
