#!/usr/bin/env bash

openclaw_frozen_target_omissions_authorized() {
  case "${OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS:-0}" in
    0 | "")
      return 1
      ;;
    1) ;;
    *)
      echo "invalid OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: expected 0 or 1" >&2
      return 2
      ;;
  esac

  if [[ ! "${OPENCLAW_SELECTED_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "OPENCLAW_SELECTED_SHA must be a full lowercase commit SHA" >&2
    return 2
  fi
  if [[ ! "${OPENCLAW_TOOLING_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "OPENCLAW_TOOLING_SHA must be a full lowercase commit SHA" >&2
    return 2
  fi
  if [[ "$OPENCLAW_SELECTED_SHA" == "$OPENCLAW_TOOLING_SHA" ]]; then
    echo "frozen-target omissions require distinct selected and tooling SHAs" >&2
    return 2
  fi
}

openclaw_resolve_frozen_plugin_prerelease_capabilities() {
  local source_root="${1:?missing selected source root}" authorization_status=0

  # Default to current assertions. A frozen target may use legacy fixtures only
  # when its checked-out source proves the complete pre-SQLite plugin profile.
  export OPENCLAW_FROZEN_PLUGIN_PRERELEASE_PROFILE="current"

  openclaw_frozen_target_omissions_authorized || authorization_status=$?
  [ "$authorization_status" -eq 1 ] && return 0
  [ "$authorization_status" -eq 0 ] || return "$authorization_status"

  if [ "$(git -C "$source_root" rev-parse HEAD 2>/dev/null)" != "$OPENCLAW_SELECTED_SHA" ]; then
    echo "selected source checkout does not match OPENCLAW_SELECTED_SHA" >&2
    return 2
  fi

  if git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/config/types.messages.ts" 2>/dev/null |
    grep -Fq 'tts?: TtsConfig;' &&
    git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/config/types.plugins.ts" 2>/dev/null |
      grep -Fq 'bundledDiscovery?: "compat" | "allowlist";' &&
    git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/plugin-sdk/session-store-runtime.ts" 2>/dev/null |
      grep -Fq 'before SQLite migration' &&
    ! git -C "$source_root" cat-file -e "$OPENCLAW_SELECTED_SHA:src/plugins/uninstall-package-plan.ts" 2>/dev/null; then
    export OPENCLAW_FROZEN_PLUGIN_PRERELEASE_PROFILE="legacy"
  fi
}
