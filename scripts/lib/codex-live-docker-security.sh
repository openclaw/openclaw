#!/usr/bin/env bash

openclaw_codex_live_prepare_security() {
  local policy_dir="${1:?policy directory required}"
  local security_options
  local parser
  CODEX_LIVE_SECURITY_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-codex-live.XXXXXX")"
  CODEX_LIVE_CONTAINER_NAME="${CODEX_LIVE_SECURITY_DIR##*/}"
  CODEX_LIVE_CONTAINER_NAME="${CODEX_LIVE_CONTAINER_NAME//./-}"
  CODEX_LIVE_APPARMOR_ATTEMPTED=0
  CODEX_LIVE_SECURITY_ARGS=(
    --name "$CODEX_LIVE_CONTAINER_NAME"
    --label "org.openclaw.codex-live-owner=$CODEX_LIVE_CONTAINER_NAME"
    --security-opt no-new-privileges
    --security-opt "seccomp=$policy_dir/seccomp.json"
  )

  security_options="$(docker_e2e_docker_cmd info --format '{{json .SecurityOptions}}')" || return $?
  if ! printf '%s\n' "$security_options" | grep -q 'name=apparmor'; then
    return 0
  fi
  if ! openclaw_live_is_ci; then
    echo "ERROR: the Codex Docker sandbox needs a temporary AppArmor policy; run this lane on a disposable CI/Testbox runner." >&2
    return 1
  fi
  parser="$(command -v apparmor_parser)" || {
    echo "ERROR: AppArmor is enabled but apparmor_parser is unavailable on this runner." >&2
    return 1
  }
  CODEX_LIVE_APPARMOR_COMMAND=("$parser")
  if [[ "$(id -u)" != 0 ]]; then
    CODEX_LIVE_APPARMOR_COMMAND=(sudo -n -- "$parser")
  fi
  CODEX_LIVE_APPARMOR_FILE="$CODEX_LIVE_SECURITY_DIR/apparmor.profile"
  sed "s/@OPENCLAW_CODEX_LIVE_PROFILE@/$CODEX_LIVE_CONTAINER_NAME/g" \
    "$policy_dir/apparmor.profile" >"$CODEX_LIVE_APPARMOR_FILE"
  # A failed parser invocation can leave an uncertain kernel load; retain it
  # until the same owner confirms removal during cleanup.
  CODEX_LIVE_APPARMOR_ATTEMPTED=1
  "${CODEX_LIVE_APPARMOR_COMMAND[@]}" --skip-cache -a "$CODEX_LIVE_APPARMOR_FILE" || return $?
  CODEX_LIVE_SECURITY_ARGS+=(--security-opt "apparmor=$CODEX_LIVE_CONTAINER_NAME")
}

openclaw_codex_live_cleanup_security() {
  local container_id
  local owner
  if [[ -z "${CODEX_LIVE_SECURITY_DIR:-}" ]]; then
    return 0
  fi
  container_id="$(docker_e2e_docker_cmd container ls -aq --filter "name=^/$CODEX_LIVE_CONTAINER_NAME$")" || return $?
  if [[ -n "$container_id" ]]; then
    owner="$(docker_e2e_docker_cmd inspect --format '{{index .Config.Labels "org.openclaw.codex-live-owner"}}' "$container_id")" || return $?
    if [[ "$owner" != "$CODEX_LIVE_CONTAINER_NAME" ]]; then
      echo "ERROR: refusing cleanup of a Codex live container owned by another run." >&2
      return 1
    fi
    docker_e2e_docker_cmd rm -f "$container_id" >/dev/null || return $?
    container_id="$(docker_e2e_docker_cmd container ls -aq --filter "name=^/$CODEX_LIVE_CONTAINER_NAME$")" || return $?
    if [[ -n "$container_id" ]]; then
      echo "ERROR: Codex live container is still present; retaining its AppArmor profile." >&2
      return 1
    fi
  fi
  # Removing a live profile would unconfine its processes. Retire the container
  # first, including on a Docker timeout or interrupted foreground client.
  if [[ "$CODEX_LIVE_APPARMOR_ATTEMPTED" == 1 ]]; then
    "${CODEX_LIVE_APPARMOR_COMMAND[@]}" --skip-cache -R "$CODEX_LIVE_APPARMOR_FILE" || return $?
  fi
  rm -rf "$CODEX_LIVE_SECURITY_DIR"
  unset CODEX_LIVE_SECURITY_DIR
}
