#!/usr/bin/env bash

docker_e2e_resource_limit_error_file() {
  local status="$1"
  local stderr_file="$2"
  local line
  [ "$status" = "125" ] || return 1

  local text=""
  while IFS= read -r line || [ -n "$line" ]; do
    text="${text}${line}
"
  done <"$stderr_file"

  case "$text" in
    *"controller pids is not available"* | *"cgroup controller pids is not available"* | \
      *"NanoCPUs can not be set"* | *"CPU CFS scheduler"* | \
      *"cgroup is not mounted"* | *"cgroup not mounted"* | \
      *"resource limit not supported"* | *"resource limits not supported"*)
      return 0
      ;;
  esac
  return 1
}

docker_e2e_resource_limit_stderr_file() {
  local template="${TMPDIR:-/tmp}/openclaw-docker-resource-limits.XXXXXX"
  if command -v mktemp >/dev/null 2>&1; then
    mktemp "$template"
    return
  fi
  if [ -x /usr/bin/mktemp ]; then
    /usr/bin/mktemp "$template"
    return
  fi
  echo "mktemp command not found; cannot capture Docker resource-limit diagnostics" >&2
  return 127
}

docker_e2e_tee_bin() {
  if command -v tee >/dev/null 2>&1; then
    command -v tee
    return
  fi
  if [ -x /usr/bin/tee ]; then
    printf '%s\n' /usr/bin/tee
    return
  fi
  return 1
}

docker_e2e_tail_bin() {
  if command -v tail >/dev/null 2>&1; then
    command -v tail
    return
  fi
  if [ -x /usr/bin/tail ]; then
    printf '%s\n' /usr/bin/tail
    return
  fi
  return 1
}

docker_e2e_remove_diagnostic_file() {
  if command -v rm >/dev/null 2>&1; then
    rm -f "$@"
    return
  fi
  /bin/rm -f "$@"
}

docker_e2e_print_resource_limit_error() {
  echo "Docker E2E resource limits are incompatible with this Docker runtime. Fix its cgroup support or explicitly opt out with OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS=1." >&2
}

docker_e2e_docker_run_with_resource_diagnostics() {
  local timeout_value="$1"
  shift
  if [ "${#DOCKER_E2E_RUN_RESOURCE_ARGS[@]}" -eq 0 ]; then
    docker_e2e_timeout_cmd "$timeout_value" docker run "$@"
    return
  fi

  local stderr_file=""
  if ! stderr_file="$(docker_e2e_resource_limit_stderr_file)"; then
    docker_e2e_timeout_cmd \
      "$timeout_value" \
      docker run "${DOCKER_E2E_RUN_RESOURCE_ARGS[@]}" "$@"
    return
  fi
  local tee_bin=""
  if ! tee_bin="$(docker_e2e_tee_bin)"; then
    docker_e2e_remove_diagnostic_file "$stderr_file"
    docker_e2e_timeout_cmd \
      "$timeout_value" \
      docker run "${DOCKER_E2E_RUN_RESOURCE_ARGS[@]}" "$@"
    return
  fi
  local tail_bin=""
  if ! tail_bin="$(docker_e2e_tail_bin)"; then
    docker_e2e_remove_diagnostic_file "$stderr_file"
    docker_e2e_timeout_cmd \
      "$timeout_value" \
      docker run "${DOCKER_E2E_RUN_RESOURCE_ARGS[@]}" "$@"
    return
  fi
  local stderr_fifo="${stderr_file}.stderr.pipe"
  local capture_fifo="${stderr_file}.capture.pipe"
  local mkfifo_bin=""
  if command -v mkfifo >/dev/null 2>&1; then
    mkfifo_bin="$(command -v mkfifo)"
  elif [ -x /usr/bin/mkfifo ]; then
    mkfifo_bin=/usr/bin/mkfifo
  fi
  local fifo_status=1
  if [ -n "$mkfifo_bin" ]; then
    local previous_umask=""
    previous_umask="$(umask)"
    umask 077
    "$mkfifo_bin" "$stderr_fifo" "$capture_fifo" && fifo_status=0 || fifo_status="$?"
    umask "$previous_umask"
  fi
  if [ "$fifo_status" -ne 0 ]; then
    docker_e2e_remove_diagnostic_file "$stderr_file" "$stderr_fifo" "$capture_fifo"
    docker_e2e_timeout_cmd \
      "$timeout_value" \
      docker run "${DOCKER_E2E_RUN_RESOURCE_ARGS[@]}" "$@"
    return
  fi

  "$tail_bin" -c 65536 <"$capture_fifo" >"$stderr_file" &
  local tail_pid="$!"
  "$tee_bin" "$capture_fifo" <"$stderr_fifo" >&2 &
  local tee_pid="$!"
  local run_status=0
  if docker_e2e_timeout_cmd \
    "$timeout_value" \
    docker run "${DOCKER_E2E_RUN_RESOURCE_ARGS[@]}" "$@" \
    2>"$stderr_fifo"; then
    run_status=0
  else
    run_status="$?"
  fi
  wait "$tee_pid" || true
  wait "$tail_pid" || true

  if docker_e2e_resource_limit_error_file "$run_status" "$stderr_file"; then
    docker_e2e_print_resource_limit_error
  fi
  docker_e2e_remove_diagnostic_file "$stderr_file" "$stderr_fifo" "$capture_fifo"
  return "$run_status"
}
