#!/usr/bin/env bash

parallels_package_acquire_build_lock() {
  local lock_dir="$1"
  local owner_pid=""
  while ! mkdir "$lock_dir" 2>/dev/null; do
    if [[ -f "$lock_dir/pid" ]]; then
      owner_pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"
      if [[ -n "$owner_pid" ]] && ! kill -0 "$owner_pid" >/dev/null 2>&1; then
        printf 'warn: Removing stale Parallels build lock\n' >&2
        rm -rf "$lock_dir"
        continue
      fi
    fi
    sleep 1
  done
  printf '%s\n' "$$" >"$lock_dir/pid"
}

parallels_package_release_build_lock() {
  local lock_dir="$1"
  if [[ -d "$lock_dir" ]]; then
    rm -rf "$lock_dir"
  fi
}
