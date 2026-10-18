#!/usr/bin/env bash

openclaw_release_prepare_docker() {
  local lane="$1"
  run_log=""
  trap 'docker_e2e_cleanup_package_run "${PACKAGE_TGZ:-}" "${run_log:-}"' EXIT
  PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz "$lane" "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}")"
  docker_e2e_package_mount_args "$PACKAGE_TGZ"
  docker_e2e_build_or_reuse "$IMAGE_NAME" "$lane" "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "bare" "$SKIP_BUILD"
  OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 "$lane" empty)"
  run_log="$(docker_e2e_run_log "$lane")"
}

openclaw_release_run_docker() {
  if ! docker_e2e_run_with_harness "$@" >"$run_log" 2>&1; then
    docker_e2e_print_log "$run_log"
    exit 1
  fi
}
