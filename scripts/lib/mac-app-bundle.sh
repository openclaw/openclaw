#!/bin/bash

resolve_mac_build_architecture() {
  local architecture="${BUILD_ARCHS:-$(uname -m)}"
  case "$architecture" in
    arm64 | x86_64) printf '%s\n' "$architecture" ;;
    *)
      echo "ERROR: Build per-architecture artifacts: set BUILD_ARCHS=arm64 or BUILD_ARCHS=x86_64. Universal and multi-architecture apps are not supported." >&2
      return 1
      ;;
  esac
}

# Both direct packaging and restart publish only a completely verified bundle.
replace_mac_app_bundle() {
  local staged="$1" target="$2" previous
  previous="$(mktemp -d "${target}.previous.XXXXXX")" || return 1
  if [[ -e "$target" ]]; then
    mv "$target" "$previous/OpenClaw.app" || return 1
  fi
  if ! mv "$staged" "$target"; then
    if [[ -e "$previous/OpenClaw.app" ]]; then
      mv "$previous/OpenClaw.app" "$target" || {
        echo "ERROR: Restore the previous app from $previous/OpenClaw.app" >&2
        return 1
      }
    fi
    rmdir "$previous"
    return 1
  fi
  rm -rf "$previous"
}
