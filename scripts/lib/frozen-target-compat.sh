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

openclaw_frozen_target_session_repair_mode() {
  local source_root="${1:?missing selected source root}"

  if ! git -C "$source_root" cat-file -e "$OPENCLAW_SELECTED_SHA:src/state/openclaw-agent-db-session-migrations.ts" 2>/dev/null &&
    git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/commands/doctor-session-transcripts.ts" 2>/dev/null |
      grep -Fq '.pre-doctor-branch-repair-'; then
    printf '%s\n' jsonl
  else
    printf '%s\n' sqlite
  fi
}

# The selected Gateway owns pairing admission. Require the declaration, the
# normalized iPhone guard, and the final allowlist contribution as one contract.
openclaw_selected_gateway_admits_ios_watch_relay() {
  local source_root="${1:?missing selected source root}" policy_source relay_declaration relay_guard allowlist

  if ! policy_source="$(
    git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/gateway/node-command-policy.ts"
  )"; then
    echo "failed to read selected Gateway node command policy" >&2
    return 2
  fi

  relay_declaration="$(
    printf '%s\n' "$policy_source" |
      sed -n '/IOS_WATCH_RELAY_COMMANDS[[:space:]]*=/,/];/p'
  )"
  relay_guard="$(
    printf '%s\n' "$policy_source" |
      sed -n '/const watchRelayCommands[[:space:]]*=/,/:[[:space:]]*\[\];/p'
  )"
  allowlist="$(
    printf '%s\n' "$policy_source" |
      sed -n '/const allow = new Set(/,/^[[:space:]]*);/p'
  )"

  printf '%s\n' "$relay_declaration" | grep -Fq '"watch.status"' &&
    printf '%s\n' "$relay_declaration" | grep -Fq '"watch.notify"' &&
    printf '%s\n' "$relay_guard" | grep -Eq 'platformId[[:space:]]*===[[:space:]]*"ios"' &&
    printf '%s\n' "$relay_guard" |
      grep -Eq 'normalizeDeviceMetadataForPolicy\(node\?\.deviceFamily\)[[:space:]]*===[[:space:]]*"iphone"' &&
    printf '%s\n' "$relay_guard" | grep -Fq '? IOS_WATCH_RELAY_COMMANDS' &&
    printf '%s\n' "$allowlist" | grep -Fq '...watchRelayCommands'
}

openclaw_resolve_frozen_plugin_harness_capabilities() {
  local source_root="${1:?missing selected source root}" authorization_status=0

  export OPENCLAW_FROZEN_TARGET_PLUGIN_UNINSTALL_MODE="current"

  openclaw_frozen_target_omissions_authorized || authorization_status=$?
  [ "$authorization_status" -eq 1 ] && return 0
  [ "$authorization_status" -eq 0 ] || return "$authorization_status"

  if [ "$(git -C "$source_root" rev-parse HEAD 2>/dev/null)" != "$OPENCLAW_SELECTED_SHA" ]; then
    echo "selected source checkout does not match OPENCLAW_SELECTED_SHA" >&2
    return 2
  fi

  # The old plugin sweep asserted removal but predated the canonical disabled
  # marker. Only that selected, packaged assertion dialect may relax the marker.
  if git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:scripts/e2e/lib/plugins/assertions.mjs" 2>/dev/null |
    grep -Fq 'function assertPluginTgzRemoved()' &&
    ! git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:scripts/e2e/lib/plugins/assertions.mjs" 2>/dev/null |
      grep -Fq 'function assertPluginUninstallConfigState('; then
    export OPENCLAW_FROZEN_TARGET_PLUGIN_UNINSTALL_MODE="legacy"
  fi
}

openclaw_resolve_frozen_upgrade_survivor_capabilities() {
  local source_root="${1:?missing selected source root}" authorization_status=0

  export OPENCLAW_UPGRADE_SURVIVOR_EXEC_APPROVALS_MODE="required" \
    OPENCLAW_UPGRADE_SURVIVOR_CLAWHUB_REQUEST_DIALECT="current" \
    OPENCLAW_UPGRADE_SURVIVOR_DISCORD_DM_CONFIG_MODE="canonical" \
    OPENCLAW_UPGRADE_SURVIVOR_MOBILE_WATCH_REAPPROVAL_MODE="required" \
    OPENCLAW_UPGRADE_SURVIVOR_SESSION_REPAIR_MODE="sqlite"

  openclaw_frozen_target_omissions_authorized || authorization_status=$?
  [ "$authorization_status" -eq 1 ] && return 0
  [ "$authorization_status" -eq 0 ] || return "$authorization_status"

  if [ "$(git -C "$source_root" rev-parse HEAD 2>/dev/null)" != "$OPENCLAW_SELECTED_SHA" ]; then
    echo "selected source checkout does not match OPENCLAW_SELECTED_SHA" >&2
    return 2
  fi

  if ! git -C "$source_root" cat-file -e "$OPENCLAW_SELECTED_SHA:src/infra/exec-approvals-sqlite.ts" 2>/dev/null &&
    git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/infra/exec-approvals.ts" 2>/dev/null |
      grep -Fq 'const EXEC_APPROVALS_FILE = "exec-approvals.json";'; then
    export OPENCLAW_UPGRADE_SURVIVOR_EXEC_APPROVALS_MODE="legacy-json"
  fi

  if ! git -C "$source_root" cat-file -e "$OPENCLAW_SELECTED_SHA:src/infra/clawhub-install-trust.ts" 2>/dev/null &&
    git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/plugins/clawhub.ts" 2>/dev/null |
      grep -Fq 'from "../infra/clawhub.js"'; then
    export OPENCLAW_UPGRADE_SURVIVOR_CLAWHUB_REQUEST_DIALECT="legacy"
  fi

  # Older upgrade-survivor contracts accepted either Discord DM shape after
  # repair. Keep asserting the policy and allowlist; only the retired-shape
  # absence is unavailable until the selected contract requires it.
  if git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:scripts/e2e/lib/upgrade-survivor/assertions.mjs" 2>/dev/null |
    grep -Fq 'const discordDmPolicy = discord.dmPolicy ?? discord.dm?.policy;'; then
    export OPENCLAW_UPGRADE_SURVIVOR_DISCORD_DM_CONFIG_MODE="legacy"
  fi

  export OPENCLAW_UPGRADE_SURVIVOR_SESSION_REPAIR_MODE
  OPENCLAW_UPGRADE_SURVIVOR_SESSION_REPAIR_MODE="$(openclaw_frozen_target_session_repair_mode "$source_root")"

  local mobile_watch_status=0
  openclaw_selected_gateway_admits_ios_watch_relay "$source_root" || mobile_watch_status=$?
  if [ "$mobile_watch_status" -eq 1 ]; then
    export OPENCLAW_UPGRADE_SURVIVOR_MOBILE_WATCH_REAPPROVAL_MODE="omitted-gateway-unsupported"
  elif [ "$mobile_watch_status" -ne 0 ]; then
    return "$mobile_watch_status"
  fi
}

openclaw_resolve_frozen_core_harness_capabilities() {
  local source_root="${1:?missing selected source root}" authorization_status=0

  export OPENCLAW_FROZEN_TARGET_ONBOARD_CASES="" \
    OPENCLAW_FROZEN_TARGET_ONBOARD_SESSION_MEMORY_HOOK_MODE="required" \
    OPENCLAW_FROZEN_TARGET_AGENT_BUNDLE_MCP_MODE="current" \
    OPENCLAW_FROZEN_TARGET_MCP_CODE_MODE_CATALOG_MODE="current" \
    OPENCLAW_FROZEN_TARGET_MCP_MEMORY_CONFIG_MODE="current" \
    OPENCLAW_FROZEN_TARGET_SESSION_REPAIR_MODE="sqlite"

  openclaw_frozen_target_omissions_authorized || authorization_status=$?
  [ "$authorization_status" -eq 1 ] && return 0
  [ "$authorization_status" -eq 0 ] || return "$authorization_status"

  if [ "$(git -C "$source_root" rev-parse HEAD 2>/dev/null)" != "$OPENCLAW_SELECTED_SHA" ]; then
    echo "selected source checkout does not match OPENCLAW_SELECTED_SHA" >&2
    return 2
  fi

  # The pre-consent onboarding flow does not accept the wizard record or the
  # newer guided case. Run its own established non-interactive coverage.
  if ! git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/config/zod-schema.ts" 2>/dev/null |
    grep -Fq 'securityAcknowledgedAt:' &&
    git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/config/zod-schema.ts" 2>/dev/null |
      grep -Fq 'lastRunAt:'; then
    export OPENCLAW_FROZEN_TARGET_ONBOARD_CASES="local-basic,remote-non-interactive,reset,channels,skills"
  fi

  # Before default-hook onboarding, quickstart offered only the hooks it found
  # in the workspace. A successful old quickstart therefore cannot promise a
  # session-memory entry when that workspace shipped no hook definition.
  if git -C "$source_root" cat-file -e "$OPENCLAW_SELECTED_SHA:src/commands/onboard-hooks.ts" 2>/dev/null &&
    git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/commands/onboard-hooks.ts" 2>/dev/null |
      grep -Fq 'setupInternalHooks' &&
    ! git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/commands/onboard-hooks.ts" 2>/dev/null |
      grep -Fq 'enableDefaultOnboardingInternalHooks'; then
    export OPENCLAW_FROZEN_TARGET_ONBOARD_SESSION_MEMORY_HOOK_MODE="interactive"
  fi

  if git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/agents/memory-search.ts" 2>/dev/null |
    grep -Fq 'cfg.agents?.defaults?.memorySearch'; then
    export OPENCLAW_FROZEN_TARGET_MCP_MEMORY_CONFIG_MODE="agent"
  fi

  # The selected release exposes ALL_TOOLS to code mode but predates the
  # catalog global. Its fixture program must use that shipped global or exec
  # throws before it can return the MCP result being proved.
  if git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/agents/code-mode-namespaces.ts" 2>/dev/null |
    grep -Fq '"ALL_TOOLS"' &&
    ! git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/agents/code-mode-namespaces.ts" 2>/dev/null |
      grep -Fq '"catalog"'; then
    export OPENCLAW_FROZEN_TARGET_MCP_CODE_MODE_CATALOG_MODE="legacy"
  fi

  export OPENCLAW_FROZEN_TARGET_SESSION_REPAIR_MODE
  OPENCLAW_FROZEN_TARGET_SESSION_REPAIR_MODE="$(openclaw_frozen_target_session_repair_mode "$source_root")"

  # The manager API and MCP App assertions were added after the selected
  # release. Run its still-packaged bundle-MCP contract instead of importing a
  # new dist entry the release cannot contain.
  if ! git -C "$source_root" cat-file -e "$OPENCLAW_SELECTED_SHA:src/agents/agent-bundle-mcp-manager-api.ts" 2>/dev/null &&
    git -C "$source_root" cat-file -e "$OPENCLAW_SELECTED_SHA:src/agents/agent-bundle-mcp-runtime.ts" 2>/dev/null &&
    git -C "$source_root" cat-file -e "$OPENCLAW_SELECTED_SHA:scripts/e2e/agent-bundle-mcp-tools-docker-client.ts" 2>/dev/null; then
    export OPENCLAW_FROZEN_TARGET_AGENT_BUNDLE_MCP_MODE="legacy"
  fi
}
