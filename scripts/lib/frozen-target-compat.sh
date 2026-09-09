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

openclaw_prepare_frozen_target_context() {
  local source_root="${1:?missing selected source root}" authorization_status=0

  openclaw_frozen_target_omissions_authorized || authorization_status=$?
  [ "$authorization_status" -eq 1 ] && return 1
  [ "$authorization_status" -eq 0 ] || return "$authorization_status"

  openclaw_frozen_target_source validate "$source_root" || return 2
}

openclaw_resolve_frozen_target_file() {
  local source_root="${1:?missing selected source root}" \
    relative_path="${2:?missing selected relative path}" \
    fallback_path="${3:-}" context_status=0 source_status=0 source_operation=has
  local frozen_missing_path="${4-$fallback_path}"

  openclaw_prepare_frozen_target_context "$source_root" || context_status=$?
  case "$context_status" in
    0)
      # The shipped survivor scenario is the sole directory-owned caller.
      [ "$relative_path" != scripts/e2e/lib/upgrade-survivor ] || source_operation=directory
      openclaw_frozen_target_source "$source_operation" "$source_root" "$relative_path" || source_status=$?
      case "$source_status" in
        0) printf '%s\n' "$source_root/$relative_path" ;;
        1) printf '%s\n' "$frozen_missing_path" ;;
        *) return "$source_status" ;;
      esac
      return 0
      ;;
    1) ;;
    *) return "$context_status" ;;
  esac
  printf '%s\n' "$fallback_path"
}

openclaw_frozen_target_source() {
  local operation="${1:?missing source operation}" source_root="${2:?missing selected source root}" helper
  shift 2
  helper="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/frozen-target-source.mjs" || return 2
  node "$helper" "$operation" "$source_root" "${OPENCLAW_SELECTED_SHA:-}" "$@"
}

openclaw_frozen_target_source_has_path() {
  openclaw_frozen_target_source has "$@"
}

openclaw_frozen_target_source_contains() {
  openclaw_frozen_target_source contains "$@"
}

# Boolean data and read errors travel separately, including inside caller `if`s.
openclaw_frozen_target_source_flag() {
  local status=0
  openclaw_frozen_target_source "$@" || status=$?
  case "$status" in
    0) printf '1' ;;
    1) printf '0' ;;
    *) return "$status" ;;
  esac
}

openclaw_resolve_frozen_gateway_network_layout() {
  local source_root="${1:?missing selected source root}" authorization_status=0 has_old has_new
  export OPENCLAW_FROZEN_TARGET_GATEWAY_NETWORK_LEGACY_LIB=""
  openclaw_prepare_frozen_target_context "$source_root" || authorization_status=$?
  [ "$authorization_status" -eq 1 ] && return 0
  [ "$authorization_status" -eq 0 ] || return "$authorization_status"

  has_old="$(openclaw_frozen_target_source_flag has "$source_root" scripts/e2e/lib/gateway-network/client.mjs)" || return 2
  if [ "$has_old" = 1 ]; then
    has_new="$(openclaw_frozen_target_source_flag has "$source_root" scripts/e2e/lib/gateway-network/client.mts)" || return 2
    if [ "$has_new" = 0 ]; then
      export OPENCLAW_FROZEN_TARGET_GATEWAY_NETWORK_LEGACY_LIB="$source_root/scripts/e2e/lib"
    fi
  fi
}

openclaw_resolve_frozen_upgrade_survivor_capabilities() {
  local source_root="${1:?missing selected source root}" authorization_status=0 has_trust has_legacy

  export OPENCLAW_FROZEN_UPGRADE_SURVIVOR_CLAWHUB_MODE="current"
  openclaw_prepare_frozen_target_context "$source_root" || authorization_status=$?
  [ "$authorization_status" -eq 1 ] && return 0
  [ "$authorization_status" -eq 0 ] || return "$authorization_status"

  # The older shipped installer fetched its official companion through ClawHub
  # and therefore owns a three-request audit instead of the current idle ledger.
  has_trust="$(openclaw_frozen_target_source_flag has "$source_root" src/infra/clawhub-install-trust.ts)" || return 2
  if [ "$has_trust" = 0 ]; then
    has_legacy="$(openclaw_frozen_target_source_flag contains "$source_root" src/plugins/clawhub.ts 'from "../infra/clawhub.js"')" || return 2
    if [ "$has_legacy" = 1 ]; then
      export OPENCLAW_FROZEN_UPGRADE_SURVIVOR_CLAWHUB_MODE="legacy"
    fi
  fi
}

openclaw_resolve_frozen_live_cli_backend_package_mode() {
  local source_root="${1:?missing selected source root}" authorization_status=0 has_resolver

  export OPENCLAW_FROZEN_TARGET_LIVE_CLI_BACKEND_PACKAGE_MODE="current"

  openclaw_prepare_frozen_target_context "$source_root" || authorization_status=$?
  [ "$authorization_status" -eq 1 ] && return 0
  [ "$authorization_status" -eq 0 ] || return "$authorization_status"

  # Older selected releases have no package resolver. Derive that one released
  # capability before Docker so the container never receives control-plane SHAs.
  has_resolver="$(openclaw_frozen_target_source_flag contains "$source_root" scripts/print-cli-backend-live-metadata.ts 'resolveCliBackendDockerPackages')" || return 2
  if [ "$has_resolver" = 0 ]; then
    export OPENCLAW_FROZEN_TARGET_LIVE_CLI_BACKEND_PACKAGE_MODE="legacy"
  fi
}

openclaw_resolve_frozen_update_channel_dry_run_mode() {
  local source_root="${1:?missing selected source root}" authorization_status=0 has_old has_new

  export OPENCLAW_UPDATE_CHANNEL_DRY_RUN_PACKAGE_COMPAT="0" \
    OPENCLAW_UPDATE_CHANNEL_DIRTY_BLOCK_EXIT_ZERO_COMPAT="0"
  openclaw_prepare_frozen_target_context "$source_root" || authorization_status=$?
  [ "$authorization_status" -eq 1 ] && return 0
  [ "$authorization_status" -eq 0 ] || return "$authorization_status"

  # The old CLI routed only an explicit dev request to Git. Recognize that
  # exact historical owner shape; backports and unknown future shapes stay strict.
  has_old="$(openclaw_frozen_target_source_flag contains \
    "$source_root" src/cli/update-cli/update-command.ts \
    'const switchToGit = requestedChannel === "dev" && installKind !== "git";')" || return 2
  if [ "$has_old" = 1 ]; then
    has_new="$(openclaw_frozen_target_source_flag contains \
      "$source_root" src/cli/update-cli/update-command.ts \
      'selectedChannel === "dev" && explicitTag === null')" || return 2
    if [ "$has_new" = 0 ]; then
      export OPENCLAW_UPDATE_CHANNEL_DRY_RUN_PACKAGE_COMPAT="1" \
        OPENCLAW_UPDATE_CHANNEL_DIRTY_BLOCK_EXIT_ZERO_COMPAT="1"
    fi
  fi
}

openclaw_resolve_frozen_plugin_harness_capabilities() {
  local source_root="${1:?missing selected source root}" authorization_status=0 has_old has_new has_tts has_discovery has_sqlite has_uninstall

  export OPENCLAW_FROZEN_TARGET_PLUGIN_UNINSTALL_MODE="current" \
    OPENCLAW_FROZEN_PLUGIN_PRERELEASE_FIXTURE_DIALECT="current"

  openclaw_prepare_frozen_target_context "$source_root" || authorization_status=$?
  [ "$authorization_status" -eq 1 ] && return 0
  [ "$authorization_status" -eq 0 ] || return "$authorization_status"

  # The old plugin sweep asserted removal but predated the canonical disabled
  # marker. Only that selected, packaged assertion dialect may relax the marker.
  has_old="$(openclaw_frozen_target_source_flag contains "$source_root" scripts/e2e/lib/plugins/assertions.mjs 'function assertPluginTgzRemoved()')" || return 2
  if [ "$has_old" = 1 ]; then
    has_new="$(openclaw_frozen_target_source_flag contains "$source_root" scripts/e2e/lib/plugins/assertions.mjs 'function assertPluginUninstallConfigState(')" || return 2
    if [ "$has_new" = 0 ]; then
      export OPENCLAW_FROZEN_TARGET_PLUGIN_UNINSTALL_MODE="legacy"
    fi
  fi

  has_tts="$(openclaw_frozen_target_source_flag contains "$source_root" src/config/types.messages.ts 'tts?: TtsConfig;')" || return 2
  [ "$has_tts" = 1 ] || return 0
  has_discovery="$(openclaw_frozen_target_source_flag contains "$source_root" src/config/types.plugins.ts 'bundledDiscovery?: "compat" | "allowlist";')" || return 2
  [ "$has_discovery" = 1 ] || return 0
  has_sqlite="$(openclaw_frozen_target_source_flag contains "$source_root" src/plugin-sdk/session-store-runtime.ts 'before SQLite migration')" || return 2
  [ "$has_sqlite" = 1 ] || return 0
  has_uninstall="$(openclaw_frozen_target_source_flag has "$source_root" src/plugins/uninstall-package-plan.ts)" || return 2
  if [ "$has_uninstall" = 0 ]; then
    export OPENCLAW_FROZEN_PLUGIN_PRERELEASE_FIXTURE_DIALECT="legacy"
  fi
}

openclaw_append_frozen_plugin_harness_docker_env() {
  if [[ "${OPENCLAW_FROZEN_TARGET_PLUGIN_UNINSTALL_MODE:-current}" == "legacy" ]]; then
    DOCKER_ENV_ARGS+=( -e "OPENCLAW_FROZEN_TARGET_PLUGIN_UNINSTALL_MODE=legacy" )
  fi
  if [[ "${OPENCLAW_FROZEN_PLUGIN_PRERELEASE_FIXTURE_DIALECT:-current}" == "legacy" ]]; then
    DOCKER_ENV_ARGS+=( -e "OPENCLAW_FROZEN_PLUGIN_PRERELEASE_FIXTURE_DIALECT=legacy" )
  fi
}

openclaw_resolve_frozen_agent_bundle_mcp_contract() {
  local source_root="${1:?missing selected source root}" authorization_status=0 resolved trusted_helper

  export OPENCLAW_FROZEN_TARGET_AGENT_BUNDLE_MCP_MODE="" \
    OPENCLAW_FROZEN_TARGET_AGENT_BUNDLE_MCP_CLIENT_PATH=""
  openclaw_frozen_target_omissions_authorized || authorization_status=$?
  if [ "$authorization_status" -eq 1 ]; then
    export OPENCLAW_FROZEN_TARGET_AGENT_BUNDLE_MCP_MODE="current" \
      OPENCLAW_FROZEN_TARGET_AGENT_BUNDLE_MCP_CLIENT_PATH="test/e2e/qa-lab/runtime/agent-bundle-mcp-tools-docker-client.ts"
    return 0
  fi
  [ "$authorization_status" -eq 0 ] || return "$authorization_status"
  trusted_helper="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/frozen-target-compat.sh" || return 2

  # Resolve the reader and parser from tooling, never from the selected checkout.
  resolved="$(node --input-type=module -e '
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const [root, sha, trustedHelper] = process.argv.slice(1);
const fail = (message) => { throw new Error(message); };
try {
  const { createFrozenTargetSource } = await import(new URL("./frozen-target-source.mjs", pathToFileURL(trustedHelper)));
  const { readText: read } = createFrozenTargetSource(root, sha);
  const required = (relativePath) => {
    const source = read(relativePath);
    if (source === null) fail(`missing required bundle source: ${relativePath}`);
    return source;
  };
  let ts;
  try { ts = createRequire(trustedHelper)("typescript"); } catch {
    fail("unable to load trusted TypeScript parser for bundle contract");
  }
  // Parse source text only: no target imports, config, plugins or type resolution.
  const parse = (relativePath, source) => {
    const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    if (file.parseDiagnostics.length) fail(`invalid selected bundle syntax contract: ${relativePath}`);
    return file;
  };
  const hasExport = (file, name) => file.statements.some((node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === name && node.body &&
    node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
    node.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
    !node.modifiers.some((modifier) =>
      [ts.SyntaxKind.DefaultKeyword, ts.SyntaxKind.DeclareKeyword].includes(modifier.kind)));
  const imports = (file) => file.statements.filter((node) =>
    ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier));
  const hasImport = (file, module, names) => imports(file).some((node) => {
    const clause = node.importClause;
    return node.moduleSpecifier.text === module && clause && !clause.isTypeOnly &&
      clause.namedBindings && ts.isNamedImports(clause.namedBindings) &&
      names.every((name) => clause.namedBindings.elements.some((element) =>
        !element.isTypeOnly && element.name.text === name &&
        (element.propertyName?.text ?? element.name.text) === name));
  });
  const importsOwner = (file, owner) => imports(file).some((node) =>
    node.moduleSpecifier.text.endsWith(`/agent-bundle-mcp-${owner}.js`));
  const layouts = [
    {
      path: "scripts/e2e/agent-bundle-mcp-tools-docker-client.ts",
      dist: "../../dist",
      helper: "./lib/temp-state-dir.ts",
    },
    {
      path: "test/e2e/qa-lab/runtime/agent-bundle-mcp-tools-docker-client.ts",
      dist: "../../../../dist",
      helper: "../../../../scripts/e2e/lib/temp-state-dir.ts",
    },
  ];
  const clients = layouts.map((layout) => ({ ...layout, source: read(layout.path) }))
    .filter((layout) => layout.source !== null);
  if (clients.length !== 1) fail("expected exactly one committed bundle client layout");
  const client = clients[0];
  const clientModule = parse(client.path, client.source);
  let manifest;
  try { manifest = JSON.parse(required("package.json")); } catch {
    fail("unable to read selected bundle package.json");
  }
  if (manifest?.type !== "module") fail("selected bundle package.json must retain ESM scope");
  const helper = parse("scripts/e2e/lib/temp-state-dir.ts", required("scripts/e2e/lib/temp-state-dir.ts"));
  if (!hasExport(helper, "createE2eStateDir") ||
      !hasImport(clientModule, client.helper, ["createE2eStateDir"])) {
    fail("unrecognized selected bundle helper contract");
  }
  const manager = read("src/agents/agent-bundle-mcp-manager-api.ts");
  const ownerName = manager === null ? "runtime" : "manager-api";
  const acquire = manager === null ? "getOrCreateSessionMcpRuntime" : "acquireSessionMcpRuntime";
  const owner = parse(`src/agents/agent-bundle-mcp-${ownerName}.ts`,
    manager ?? required("src/agents/agent-bundle-mcp-runtime.ts"));
  if (!hasExport(owner, acquire) || !hasExport(owner, "disposeAllSessionMcpRuntimes") ||
      !hasImport(clientModule, `${client.dist}/agents/agent-bundle-mcp-${ownerName}.js`,
        [acquire, "disposeAllSessionMcpRuntimes"]) ||
      (manager !== null && client.path !== layouts[1].path) ||
      importsOwner(clientModule, manager === null ? "manager-api" : "runtime")) {
    fail("unrecognized selected bundle client/API contract");
  }
  process.stdout.write(`${manager === null ? "legacy" : "current"}:${client.path}`);
} catch (error) {
  console.error(`frozen bundle contract: unable to read selected bundle source: ${error.message}`);
  process.exitCode = 2;
}
' "$source_root" "$OPENCLAW_SELECTED_SHA" "$trusted_helper")" || return 2

  export OPENCLAW_FROZEN_TARGET_AGENT_BUNDLE_MCP_MODE="${resolved%%:*}" \
    OPENCLAW_FROZEN_TARGET_AGENT_BUNDLE_MCP_CLIENT_PATH="${resolved#*:}"
}

openclaw_resolve_frozen_core_harness_capabilities() {
  local source_root="${1:?missing selected source root}" authorization_status=0
  local has_access has_last_run has_hooks has_setup has_default_hooks has_memory has_migrations has_repair
  local has_extract has_model_prompt has_fragments has_filter has_all_tools has_catalog

  export OPENCLAW_FROZEN_TARGET_ONBOARD_CASES="" \
    OPENCLAW_FROZEN_TARGET_ONBOARD_SESSION_MEMORY_HOOK_MODE="required" \
    OPENCLAW_FROZEN_TARGET_MCP_MEMORY_CONFIG_MODE="current" \
    OPENCLAW_FROZEN_TARGET_MCP_CODE_MODE_CATALOG_MODE="current" \
    OPENCLAW_FROZEN_TARGET_RUNTIME_CONTEXT_INPUT_MODE="producer-fragments" \
    OPENCLAW_FROZEN_TARGET_SESSION_REPAIR_MODE="sqlite"

  openclaw_prepare_frozen_target_context "$source_root" || authorization_status=$?
  [ "$authorization_status" -eq 1 ] && return 0
  [ "$authorization_status" -eq 0 ] || return "$authorization_status"

  # Older onboarding schemas do not accept the guided fixture's full wizard
  # consent record. Run their own established non-interactive coverage.
  has_access="$(openclaw_frozen_target_source_flag contains "$source_root" src/config/zod-schema.ts 'accessMode:')" || return 2
  if [ "$has_access" = 0 ]; then
    has_last_run="$(openclaw_frozen_target_source_flag contains "$source_root" src/config/zod-schema.ts 'lastRunAt:')" || return 2
    if [ "$has_last_run" = 1 ]; then
      export OPENCLAW_FROZEN_TARGET_ONBOARD_CASES="local-basic,remote-non-interactive,reset,channels,skills"
    fi
  fi

  # Before default-hook onboarding, quickstart offered only the hooks it found
  # in the workspace. A successful old quickstart therefore cannot promise a
  # session-memory entry when that workspace shipped no hook definition.
  has_hooks="$(openclaw_frozen_target_source_flag has "$source_root" src/commands/onboard-hooks.ts)" || return 2
  if [ "$has_hooks" = 1 ]; then
    has_setup="$(openclaw_frozen_target_source_flag contains "$source_root" src/commands/onboard-hooks.ts 'setupInternalHooks')" || return 2
    if [ "$has_setup" = 1 ]; then
      has_default_hooks="$(openclaw_frozen_target_source_flag contains "$source_root" src/commands/onboard-hooks.ts 'enableDefaultOnboardingInternalHooks')" || return 2
      if [ "$has_default_hooks" = 0 ]; then
        export OPENCLAW_FROZEN_TARGET_ONBOARD_SESSION_MEMORY_HOOK_MODE="interactive"
      fi
    fi
  fi

  has_memory="$(openclaw_frozen_target_source_flag contains "$source_root" src/agents/memory-search.ts 'cfg.agents?.defaults?.memorySearch')" || return 2
  if [ "$has_memory" = 1 ]; then
    export OPENCLAW_FROZEN_TARGET_MCP_MEMORY_CONFIG_MODE="agent"
  fi

  has_migrations="$(openclaw_frozen_target_source_flag has "$source_root" src/state/openclaw-agent-db-session-migrations.ts)" || return 2
  if [ "$has_migrations" = 0 ]; then
    has_repair="$(openclaw_frozen_target_source_flag contains "$source_root" src/commands/doctor-session-transcripts.ts '.pre-doctor-branch-repair-')" || return 2
    if [ "$has_repair" = 1 ]; then
      export OPENCLAW_FROZEN_TARGET_SESSION_REPAIR_MODE="jsonl"
    fi
  fi

  local runtime_context_path="src/agents/embedded-agent-runner/run/runtime-context-prompt.ts"
  local has_legacy_runtime_context=0 has_producer_runtime_context=0
  has_extract="$(openclaw_frozen_target_source_flag contains "$source_root" "$runtime_context_path" 'extractInternalRuntimeContext')" || return 2
  if [ "$has_extract" = 1 ]; then
    has_model_prompt="$(openclaw_frozen_target_source_flag contains "$source_root" "$runtime_context_path" 'modelPrompt?: string;')" || return 2
    has_legacy_runtime_context="$has_model_prompt"
  fi
  has_fragments="$(openclaw_frozen_target_source_flag contains "$source_root" "$runtime_context_path" 'fragments?: RuntimeContextFragment[];')" || return 2
  if [ "$has_fragments" = 1 ]; then
    has_filter="$(openclaw_frozen_target_source_flag contains "$source_root" "$runtime_context_path" 'const fragments = params.fragments?.filter')" || return 2
    has_producer_runtime_context="$has_filter"
  fi
  case "$has_producer_runtime_context:$has_legacy_runtime_context" in
    1:0) ;;
    0:1)
      export OPENCLAW_FROZEN_TARGET_RUNTIME_CONTEXT_INPUT_MODE="legacy-marked-prompt"
      ;;
    *)
      echo "unable to resolve frozen runtime-context input contract from selected source" >&2
      return 2
      ;;
  esac

  # The selected release exposes ALL_TOOLS to code mode but predates the
  # catalog global. Its fixture must use the global the package actually ships.
  has_all_tools="$(openclaw_frozen_target_source_flag contains "$source_root" src/agents/code-mode-namespaces.ts '"ALL_TOOLS"')" || return 2
  if [ "$has_all_tools" = 1 ]; then
    has_catalog="$(openclaw_frozen_target_source_flag contains "$source_root" src/agents/code-mode-namespaces.ts '"catalog"')" || return 2
    if [ "$has_catalog" = 0 ]; then
      export OPENCLAW_FROZEN_TARGET_MCP_CODE_MODE_CATALOG_MODE="legacy"
    fi
  fi
}
