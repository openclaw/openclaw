import { o as resolveCompatibilityHostVersion } from "./version-DdTF4eka.js";
import { t as isBlockedObjectKey } from "./prototype-keys-BWjW0VW8.js";
import { f as safeRealpathSync, t as discoverOpenClawPlugins } from "./discovery-CVL9-KJt.js";
import { r as hasKind } from "./slots-CQk-Ab1S.js";
import { c as resolveEffectiveEnableState, l as resolveEffectivePluginActivationState, s as normalizePluginsConfig } from "./config-state-wKtsQXM5.js";
import { t as describePluginInstallSource } from "./install-source-info-D4ewXUGX.js";
import { a as readJsonFileSync, i as readJsonFile, o as writeJsonAtomic } from "./json-files-DPM4MwsB.js";
import { s as loadInstalledPluginIndexInstallRecordsSync, t as loadPluginManifestRegistry, u as resolveInstalledPluginIndexStorePath } from "./manifest-registry-BiAsJcRZ.js";
import { n as saveJsonFile } from "./json-file-BDXsHiio.js";
import { n as safeParseWithSchema } from "./zod-parse-ByT__FkO.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
//#region src/plugins/compat/registry.ts
const CHANNEL_RUNTIME_SDK_SURFACE = ["openclaw/plugin-sdk/channel", "runtime"].join("-");
const LEGACY_CONFIG_MIGRATE_TEST_PATH = ["src/commands/doctor/shared/legacy-config", "migrate.test.ts"].join("-");
const PLUGIN_COMPAT_RECORDS = [
	{
		code: "legacy-before-agent-start",
		status: "deprecated",
		owner: "sdk",
		introduced: "2026-04-24",
		deprecated: "2026-04-24",
		warningStarts: "2026-04-24",
		removeAfter: "2026-07-24",
		replacement: "`before_model_resolve` and `before_prompt_build` hooks",
		docsPath: "/plugins/sdk-migration",
		surfaces: [
			"plugin hooks",
			"plugins inspect",
			"status diagnostics"
		],
		diagnostics: ["plugin compatibility notice"],
		tests: ["src/plugins/status.test.ts", "src/plugins/contracts/shape.contract.test.ts"],
		releaseNote: "Legacy `before_agent_start` hook compatibility remains wired while plugins migrate to modern hook stages."
	},
	{
		code: "hook-only-plugin-shape",
		status: "active",
		owner: "sdk",
		introduced: "2026-04-24",
		replacement: "explicit capability registration",
		docsPath: "/plugins/sdk-migration",
		surfaces: [
			"plugin shape inspection",
			"plugins inspect",
			"status diagnostics"
		],
		diagnostics: ["plugin compatibility notice"],
		tests: ["src/plugins/status.test.ts", "src/plugins/contracts/shape.contract.test.ts"]
	},
	{
		code: "legacy-root-sdk-import",
		status: "deprecated",
		owner: "sdk",
		introduced: "2026-04-24",
		deprecated: "2026-04-24",
		warningStarts: "2026-04-24",
		removeAfter: "2026-07-24",
		replacement: "focused `openclaw/plugin-sdk/<subpath>` imports",
		docsPath: "/plugins/sdk-migration",
		surfaces: ["openclaw/plugin-sdk", "openclaw/plugin-sdk/compat"],
		diagnostics: ["OPENCLAW_PLUGIN_SDK_COMPAT_DEPRECATED"],
		tests: [
			"src/plugins/contracts/plugin-sdk-index.test.ts",
			"src/plugins/contracts/plugin-sdk-root-alias.test.ts",
			"src/plugins/contracts/plugin-sdk-subpaths.test.ts"
		]
	},
	{
		code: "hook.before_tool_call.terminal-block-approval",
		status: "active",
		owner: "agent-runtime",
		introduced: "2026-04-29",
		docsPath: "/plugins/hooks",
		surfaces: ["before_tool_call block result", "before_tool_call approval result"],
		diagnostics: ["hook runner contract probe"],
		tests: ["src/plugins/hooks.security.test.ts", "src/agents/pi-tools.before-tool-call.e2e.test.ts"]
	},
	{
		code: "hook.llm-observer.privacy-payload",
		status: "active",
		owner: "agent-runtime",
		introduced: "2026-04-29",
		docsPath: "/plugins/hooks",
		surfaces: [
			"llm_input",
			"llm_output",
			"agent_end",
			"allowConversationAccess"
		],
		diagnostics: ["conversation access hook contract probe"],
		tests: ["src/agents/cli-runner.reliability.test.ts", "src/config/schema.help.quality.test.ts"]
	},
	{
		code: "api.capture.runtime-registrars",
		status: "active",
		owner: "plugin-execution",
		introduced: "2026-04-29",
		docsPath: "/plugins/architecture-internals",
		surfaces: [
			"createCapturedPluginRegistration",
			"capturePluginRegistration",
			"OpenClawPluginApi"
		],
		diagnostics: ["runtime registration capture contract probe"],
		tests: ["src/plugins/captured-registration.test.ts"]
	},
	{
		code: "channel.runtime.envelope-config-metadata",
		status: "active",
		owner: "channel",
		introduced: "2026-04-29",
		docsPath: "/plugins/sdk-channel-plugins",
		surfaces: [
			"api.registerChannel",
			"channel setup metadata",
			"channel message envelope"
		],
		diagnostics: ["channel runtime contract probe"],
		tests: ["src/plugin-sdk/channel-entry-contract.test.ts", "src/plugins/captured-registration.test.ts"]
	},
	{
		code: "bundled-channel-sdk-compat-facades",
		status: "active",
		owner: "sdk",
		introduced: "2026-04-28",
		replacement: "generic channel SDK subpaths or plugin-local `api.ts` / `runtime-api.ts` barrels for new plugins",
		docsPath: "/plugins/sdk-overview",
		surfaces: ["openclaw/plugin-sdk/discord component message helpers", "openclaw/plugin-sdk/telegram-account resolveTelegramAccount"],
		diagnostics: ["plugin SDK compatibility registry"],
		tests: [
			"src/plugin-sdk/discord.test.ts",
			"src/plugin-sdk/telegram-account.test.ts",
			"src/plugins/contracts/plugin-sdk-package-contract-guardrails.test.ts"
		]
	},
	{
		code: "bundled-channel-config-schema-legacy",
		status: "deprecated",
		owner: "sdk",
		introduced: "2026-04-28",
		deprecated: "2026-04-28",
		warningStarts: "2026-04-28",
		removeAfter: "2026-07-28",
		replacement: "`openclaw/plugin-sdk/bundled-channel-config-schema` for maintained bundled plugins; plugin-local schemas for third-party plugins",
		docsPath: "/plugins/sdk-migration",
		surfaces: ["openclaw/plugin-sdk/channel-config-schema-legacy"],
		diagnostics: ["plugin SDK compatibility warning"],
		tests: ["src/plugins/contracts/config-footprint-guardrails.test.ts", "test/extension-test-boundary.test.ts"]
	},
	{
		code: "plugin-sdk-testing-barrel",
		status: "deprecated",
		owner: "sdk",
		introduced: "2026-04-28",
		deprecated: "2026-04-28",
		warningStarts: "2026-04-28",
		removeAfter: "2026-07-28",
		replacement: "focused `openclaw/plugin-sdk/*` test subpaths such as `plugin-test-runtime`, `channel-test-helpers`, `test-env`, and `test-fixtures`",
		docsPath: "/plugins/sdk-migration",
		surfaces: ["openclaw/plugin-sdk/testing"],
		diagnostics: ["plugin SDK compatibility warning"],
		tests: [
			"src/plugins/compat/registry.test.ts",
			"scripts/check-no-extension-test-core-imports.ts",
			"test/extension-test-boundary.test.ts"
		]
	},
	{
		code: "channel-route-key-aliases",
		status: "deprecated",
		owner: "sdk",
		introduced: "2026-04-28",
		deprecated: "2026-04-28",
		warningStarts: "2026-04-28",
		removeAfter: "2026-07-28",
		replacement: "`channelRouteDedupeKey` and `channelRouteCompactKey`",
		docsPath: "/plugins/sdk-migration",
		surfaces: ["openclaw/plugin-sdk/channel-route channelRouteIdentityKey", "openclaw/plugin-sdk/channel-route channelRouteKey"],
		diagnostics: ["plugin SDK compatibility warning"],
		tests: ["src/plugin-sdk/channel-route.test.ts", "src/plugins/contracts/plugin-sdk-subpaths.test.ts"]
	},
	{
		code: "channel-target-comparable-aliases",
		status: "deprecated",
		owner: "sdk",
		introduced: "2026-04-28",
		deprecated: "2026-04-28",
		warningStarts: "2026-04-28",
		removeAfter: "2026-07-28",
		replacement: "`resolveRouteTargetForChannel`, `ChannelRouteParsedTarget`, `channelRouteTargetsMatchExact`, and `channelRouteTargetsShareConversation`",
		docsPath: "/plugins/sdk-migration",
		surfaces: [
			"src/channels/plugins/target-parsing ComparableChannelTarget",
			"src/channels/plugins/target-parsing resolveComparableTargetForChannel",
			"src/channels/plugins/target-parsing comparableChannelTargetsMatch",
			"src/channels/plugins/target-parsing comparableChannelTargetsShareRoute"
		],
		diagnostics: ["plugin SDK compatibility warning"],
		tests: ["src/channels/plugins/target-parsing.test.ts", "src/plugins/contracts/plugin-sdk-subpaths.test.ts"]
	},
	{
		code: "bundled-plugin-allowlist",
		status: "active",
		owner: "config",
		introduced: "2026-04-24",
		replacement: "manifest-owned plugin enablement and scoped load plans",
		docsPath: "/plugins/architecture",
		surfaces: [
			"plugins.allow",
			"bundled provider startup",
			"plugins status"
		],
		diagnostics: ["plugin status report"],
		tests: ["src/plugins/status.test.ts", "src/plugins/config-state.test.ts"]
	},
	{
		code: "bundled-plugin-enablement",
		status: "active",
		owner: "config",
		introduced: "2026-04-24",
		replacement: "manifest-owned plugin defaults and scoped load plans",
		docsPath: "/plugins/architecture",
		surfaces: [
			"plugins.entries",
			"bundled provider startup",
			"plugins status"
		],
		diagnostics: ["plugin status report"],
		tests: ["src/plugins/status.test.ts", "src/plugins/config-state.test.ts"]
	},
	{
		code: "bundled-plugin-vitest-defaults",
		status: "active",
		owner: "config",
		introduced: "2026-04-24",
		replacement: "explicit test plugin config fixtures",
		docsPath: "/plugins/architecture",
		surfaces: ["Vitest plugin defaults", "bundled provider tests"],
		diagnostics: ["test-only compatibility path"],
		tests: ["src/plugins/config-state.test.ts"]
	},
	{
		code: "provider-auth-env-vars",
		status: "deprecated",
		owner: "setup",
		introduced: "2026-04-24",
		deprecated: "2026-04-24",
		warningStarts: "2026-04-24",
		removeAfter: "2026-07-24",
		replacement: "`setup.providers[].envVars` and `providerAuthChoices`",
		docsPath: "/plugins/manifest",
		surfaces: ["openclaw.plugin.json providerAuthEnvVars", "provider setup"],
		diagnostics: ["manifest compatibility diagnostic"],
		tests: ["src/plugins/setup-registry.test.ts", "src/plugins/provider-auth-choices.test.ts"]
	},
	{
		code: "channel-env-vars",
		status: "deprecated",
		owner: "channel",
		introduced: "2026-04-24",
		deprecated: "2026-04-24",
		warningStarts: "2026-04-24",
		removeAfter: "2026-07-24",
		replacement: "`channelConfigs.<id>.schema` and setup descriptors",
		docsPath: "/plugins/manifest",
		surfaces: ["openclaw.plugin.json channelEnvVars", "channel setup"],
		diagnostics: ["manifest compatibility diagnostic"],
		tests: ["src/plugins/setup-registry.test.ts", "src/channels/plugins/setup-group-access.test.ts"]
	},
	{
		code: "activation-agent-harness-hint",
		status: "active",
		owner: "plugin-execution",
		introduced: "2026-04-24",
		replacement: "top-level `cliBackends[]` for CLI aliases and future `agentRuntime` ownership metadata",
		docsPath: "/plugins/manifest",
		surfaces: ["activation.onAgentHarnesses", "activation planner"],
		diagnostics: ["activation plan compat reason"],
		tests: ["src/plugins/activation-planner.test.ts"]
	},
	{
		code: "activation-provider-hint",
		status: "active",
		owner: "plugin-execution",
		introduced: "2026-04-24",
		replacement: "`providers[]` manifest ownership",
		docsPath: "/plugins/manifest",
		surfaces: ["activation.onProviders", "activation planner"],
		diagnostics: ["activation plan compat reason"],
		tests: ["src/plugins/activation-planner.test.ts"]
	},
	{
		code: "activation-channel-hint",
		status: "active",
		owner: "plugin-execution",
		introduced: "2026-04-24",
		replacement: "`channels[]` manifest ownership",
		docsPath: "/plugins/manifest",
		surfaces: ["activation.onChannels", "activation planner"],
		diagnostics: ["activation plan compat reason"],
		tests: ["src/plugins/activation-planner.test.ts"]
	},
	{
		code: "activation-command-hint",
		status: "active",
		owner: "plugin-execution",
		introduced: "2026-04-24",
		replacement: "`commandAliases` or command contribution metadata",
		docsPath: "/plugins/manifest",
		surfaces: ["activation.onCommands", "activation planner"],
		diagnostics: ["activation plan compat reason"],
		tests: ["src/plugins/activation-planner.test.ts"]
	},
	{
		code: "activation-route-hint",
		status: "active",
		owner: "plugin-execution",
		introduced: "2026-04-24",
		replacement: "HTTP route contribution metadata",
		docsPath: "/plugins/manifest",
		surfaces: ["activation.onRoutes", "activation planner"],
		diagnostics: ["activation plan compat reason"],
		tests: ["src/plugins/activation-planner.test.ts"]
	},
	{
		code: "activation-config-path-hint",
		status: "active",
		owner: "plugin-execution",
		introduced: "2026-04-27",
		replacement: "manifest contribution ownership for root config surfaces",
		docsPath: "/plugins/manifest",
		surfaces: ["activation.onConfigPaths", "startup plugin selection"],
		diagnostics: ["activation plan compat reason"],
		tests: ["src/plugins/channel-plugin-ids.test.ts"]
	},
	{
		code: "activation-capability-hint",
		status: "active",
		owner: "plugin-execution",
		introduced: "2026-04-24",
		replacement: "manifest contribution ownership",
		docsPath: "/plugins/manifest",
		surfaces: ["activation.onCapabilities", "activation planner"],
		diagnostics: ["activation plan compat reason"],
		tests: ["src/plugins/activation-planner.test.ts"]
	},
	{
		code: "embedded-harness-config-alias",
		status: "deprecated",
		owner: "agent-runtime",
		introduced: "2026-04-24",
		deprecated: "2026-04-25",
		warningStarts: "2026-04-25",
		removeAfter: "2026-07-25",
		replacement: "`agentRuntime` config naming",
		docsPath: "/plugins/sdk-agent-harness",
		surfaces: ["agents.defaults.embeddedHarness", "model/provider runtime selection"],
		diagnostics: ["agent runtime config compatibility"],
		tests: [LEGACY_CONFIG_MIGRATE_TEST_PATH]
	},
	{
		code: "agent-harness-sdk-alias",
		status: "deprecated",
		owner: "agent-runtime",
		introduced: "2026-04-24",
		deprecated: "2026-04-25",
		warningStarts: "2026-04-25",
		removeAfter: "2026-07-25",
		replacement: "`openclaw/plugin-sdk/agent-runtime`",
		docsPath: "/plugins/sdk-agent-harness",
		surfaces: ["openclaw/plugin-sdk/agent-harness", "openclaw/plugin-sdk/agent-harness-runtime"],
		diagnostics: ["plugin SDK compatibility warning"],
		tests: ["src/plugins/contracts/plugin-sdk-subpaths.test.ts"]
	},
	{
		code: "agent-harness-id-alias",
		status: "deprecated",
		owner: "agent-runtime",
		introduced: "2026-04-24",
		deprecated: "2026-04-25",
		warningStarts: "2026-04-25",
		removeAfter: "2026-07-25",
		replacement: "`agentRuntime` ids and policy metadata",
		docsPath: "/plugins/sdk-agent-harness",
		surfaces: ["manifest/catalog execution policy", "runtime selection"],
		diagnostics: ["agent runtime compatibility warning"],
		tests: ["src/plugins/provider-runtime.test.ts", "src/web/provider-runtime-shared.test.ts"]
	},
	{
		code: "generated-bundled-channel-config-fallback",
		status: "active",
		owner: "channel",
		introduced: "2026-04-24",
		replacement: "manifest registry `channelConfigs` metadata",
		docsPath: "/plugins/manifest",
		surfaces: ["generated bundled channel config metadata", "channel config validation"],
		diagnostics: ["channel config metadata fallback"],
		tests: ["src/plugins/contracts/config-footprint-guardrails.test.ts"]
	},
	{
		code: "disable-persisted-plugin-registry-env",
		status: "deprecated",
		owner: "config",
		introduced: "2026-04-25",
		deprecated: "2026-04-25",
		warningStarts: "2026-04-25",
		removeAfter: "2026-07-25",
		replacement: "`openclaw plugins registry --refresh` and `openclaw doctor --fix`",
		docsPath: "/cli/plugins#registry",
		surfaces: ["OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY", "plugin registry reads"],
		diagnostics: ["persisted-registry-disabled"],
		tests: ["src/plugins/plugin-registry.test.ts"]
	},
	{
		code: "plugin-registry-install-migration-env",
		status: "deprecated",
		owner: "config",
		introduced: "2026-04-25",
		deprecated: "2026-04-25",
		warningStarts: "2026-04-25",
		removeAfter: "2026-07-25",
		replacement: "`openclaw plugins registry --refresh` and `openclaw doctor --fix`",
		docsPath: "/cli/plugins#registry",
		surfaces: [
			"OPENCLAW_DISABLE_PLUGIN_REGISTRY_MIGRATION",
			"OPENCLAW_FORCE_PLUGIN_REGISTRY_MIGRATION",
			"package postinstall plugin registry migration"
		],
		diagnostics: ["postinstall migration skip", "postinstall migration force deprecation warning"],
		tests: ["src/commands/doctor/shared/plugin-registry-migration.test.ts"]
	},
	{
		code: "plugin-install-config-ledger",
		status: "deprecated",
		owner: "config",
		introduced: "2026-04-25",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "state-managed `plugins/installs.json` install ledger",
		docsPath: "/cli/plugins#registry",
		surfaces: ["plugins.installs authored config", "plugin install/update migration"],
		diagnostics: ["config write migration warning", "doctor registry migration"],
		tests: ["src/config/io.write-config.test.ts", "src/commands/doctor/shared/plugin-registry-migration.test.ts"]
	},
	{
		code: "bundled-plugin-load-path-aliases",
		status: "deprecated",
		owner: "config",
		introduced: "2026-04-25",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "packaged bundled plugins resolved through the persisted plugin registry",
		docsPath: "/cli/plugins#registry",
		surfaces: ["plugins.load.paths entries pointing at bundled plugin source/dist paths"],
		diagnostics: ["doctor bundled plugin load-path warning"],
		tests: ["src/commands/doctor/shared/bundled-plugin-load-paths.test.ts"]
	},
	{
		code: "plugin-owned-web-search-config",
		status: "deprecated",
		owner: "provider",
		introduced: "2026-04-26",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "`plugins.entries.<plugin>.config.webSearch`",
		docsPath: "/tools/web",
		surfaces: ["tools.web.search.apiKey", "tools.web.search.<provider>"],
		diagnostics: ["doctor legacy web-search config migration"],
		tests: ["src/commands/doctor/shared/legacy-web-search-migrate.test.ts"]
	},
	{
		code: "plugin-owned-web-fetch-config",
		status: "deprecated",
		owner: "provider",
		introduced: "2026-04-26",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "`plugins.entries.firecrawl.config.webFetch`",
		docsPath: "/tools/web-fetch",
		surfaces: ["tools.web.fetch.firecrawl"],
		diagnostics: ["doctor legacy web-fetch config migration"],
		tests: ["src/commands/doctor/shared/legacy-web-fetch-migrate.test.ts"]
	},
	{
		code: "plugin-owned-x-search-config",
		status: "deprecated",
		owner: "provider",
		introduced: "2026-04-26",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "`plugins.entries.xai.config.webSearch.apiKey`",
		docsPath: "/tools/grok-search",
		surfaces: ["tools.web.x_search.apiKey"],
		diagnostics: ["doctor legacy x_search config migration"],
		tests: ["src/commands/doctor/shared/legacy-x-search-migrate.test.ts", LEGACY_CONFIG_MIGRATE_TEST_PATH]
	},
	{
		code: "plugin-activate-entrypoint-alias",
		status: "deprecated",
		owner: "sdk",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "`register(api)` plugin entrypoint",
		docsPath: "/plugins/sdk-entrypoints",
		surfaces: ["plugin module `activate(api)`", "plugin loader registration"],
		diagnostics: ["loader compatibility path"],
		tests: ["src/plugins/loader.test.ts"]
	},
	{
		code: "setup-runtime-fallback",
		status: "active",
		owner: "setup",
		introduced: "2026-04-24",
		replacement: "`setup.requiresRuntime: false` with complete setup descriptors",
		docsPath: "/plugins/manifest#setup-reference",
		surfaces: ["setup-api runtime fallback", "setup.requiresRuntime omitted"],
		diagnostics: ["setup registry runtime diagnostic"],
		tests: ["src/plugins/setup-registry.test.ts", "src/plugins/setup-registry.runtime.test.ts"]
	},
	{
		code: "provider-discovery-hook-alias",
		status: "deprecated",
		owner: "provider",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "`catalog.run(...)` provider catalog hook",
		docsPath: "/plugins/sdk-migration",
		surfaces: ["provider plugin `discovery` hook", "provider catalog resolution"],
		diagnostics: ["provider validation warning when catalog and discovery both register"],
		tests: ["src/plugins/provider-discovery.test.ts", "src/plugins/provider-validation.test.ts"]
	},
	{
		code: "channel-exposure-legacy-aliases",
		status: "deprecated",
		owner: "channel",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "`openclaw.channel.exposure` metadata",
		docsPath: "/plugins/sdk-setup",
		surfaces: ["openclaw.channel.showConfigured", "openclaw.channel.showInSetup"],
		diagnostics: ["channel exposure compatibility path"],
		tests: ["src/commands/channel-setup/discovery.test.ts"]
	},
	{
		code: "channel-runtime-sdk-alias",
		status: "deprecated",
		owner: "sdk",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "focused channel SDK subpaths, especially `openclaw/plugin-sdk/channel-runtime-context`",
		docsPath: "/plugins/sdk-migration",
		surfaces: [CHANNEL_RUNTIME_SDK_SURFACE],
		diagnostics: ["plugin SDK compatibility warning"],
		tests: ["src/plugins/contracts/plugin-sdk-subpaths.test.ts"]
	},
	{
		code: "command-auth-status-builders",
		status: "deprecated",
		owner: "sdk",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "`openclaw/plugin-sdk/command-status`",
		docsPath: "/plugins/sdk-migration",
		surfaces: [
			"openclaw/plugin-sdk/command-auth buildCommandsMessage",
			"openclaw/plugin-sdk/command-auth buildCommandsMessagePaginated",
			"openclaw/plugin-sdk/command-auth buildHelpMessage"
		],
		diagnostics: ["plugin SDK compatibility warning"],
		tests: ["src/plugin-sdk/command-auth.test.ts"]
	},
	{
		code: "clawdbot-config-type-alias",
		status: "deprecated",
		owner: "sdk",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "`OpenClawConfig`",
		docsPath: "/plugins/sdk-migration",
		surfaces: ["openclaw/plugin-sdk `ClawdbotConfig` type export"],
		diagnostics: ["plugin SDK compatibility warning"],
		tests: ["src/plugins/contracts/plugin-sdk-index.test.ts"]
	},
	{
		code: "openclaw-schema-type-alias",
		status: "deprecated",
		owner: "sdk",
		introduced: "2026-04-26",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "`OpenClawConfig` from `openclaw/plugin-sdk/config-schema`",
		docsPath: "/plugins/sdk-migration",
		surfaces: ["openclaw/plugin-sdk `OpenClawSchemaType` type export"],
		diagnostics: ["plugin SDK compatibility warning"],
		tests: ["src/plugins/contracts/plugin-sdk-index.test.ts"]
	},
	{
		code: "legacy-extension-api-import",
		status: "deprecated",
		owner: "sdk",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "injected `api.runtime.*` helpers or focused `openclaw/plugin-sdk/<subpath>` imports",
		docsPath: "/plugins/sdk-migration",
		surfaces: ["openclaw/extension-api"],
		diagnostics: ["OPENCLAW_EXTENSION_API_DEPRECATED"],
		tests: ["src/plugins/sdk-alias.test.ts", "src/index.test.ts"]
	},
	{
		code: "memory-split-registration",
		status: "deprecated",
		owner: "sdk",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "`api.registerMemoryCapability({ promptBuilder, flushPlanResolver, runtime })`",
		docsPath: "/plugins/sdk-migration",
		surfaces: [
			"api.registerMemoryPromptSection",
			"api.registerMemoryFlushPlan",
			"api.registerMemoryRuntime",
			"src/plugins/memory-state split registration helpers"
		],
		diagnostics: ["plugin SDK compatibility warning"],
		tests: ["src/plugins/memory-state.test.ts", "src/plugins/loader.test.ts"]
	},
	{
		code: "provider-static-capabilities-bag",
		status: "deprecated",
		owner: "provider",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "explicit provider hooks such as `buildReplayPolicy`, `normalizeToolSchemas`, and `wrapStreamFn`",
		docsPath: "/plugins/sdk-provider-plugins",
		surfaces: ["ProviderPlugin.capabilities", "ProviderCapabilities"],
		diagnostics: ["provider validation warning"],
		tests: ["src/plugins/provider-runtime.test.ts", "src/plugins/contracts/provider-family-plugin-tests.test.ts"]
	},
	{
		code: "provider-discovery-type-aliases",
		status: "deprecated",
		owner: "provider",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "`ProviderCatalogOrder`, `ProviderCatalogContext`, `ProviderCatalogResult`, and `ProviderPluginCatalog`",
		docsPath: "/plugins/sdk-migration",
		surfaces: [
			"ProviderDiscoveryOrder",
			"ProviderDiscoveryContext",
			"ProviderDiscoveryResult",
			"ProviderPluginDiscovery"
		],
		diagnostics: ["plugin SDK compatibility warning"],
		tests: ["src/plugins/contracts/plugin-sdk-index.test.ts"]
	},
	{
		code: "provider-thinking-policy-hooks",
		status: "deprecated",
		owner: "provider",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "`resolveThinkingProfile`",
		docsPath: "/plugins/sdk-provider-plugins",
		surfaces: [
			"ProviderPlugin.isBinaryThinking",
			"ProviderPlugin.supportsXHighThinking",
			"ProviderPlugin.resolveDefaultThinkingLevel"
		],
		diagnostics: ["provider runtime compatibility warning"],
		tests: ["src/plugins/provider-runtime.test.ts"]
	},
	{
		code: "provider-external-oauth-profiles-hook",
		status: "deprecated",
		owner: "provider",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "`contracts.externalAuthProviders` plus `resolveExternalAuthProfiles`",
		docsPath: "/plugins/sdk-provider-plugins",
		surfaces: ["ProviderPlugin.resolveExternalOAuthProfiles"],
		diagnostics: ["provider external auth fallback warning"],
		tests: ["src/plugins/provider-runtime.test.ts"]
	},
	{
		code: "agent-tool-result-harness-alias",
		status: "deprecated",
		owner: "agent-runtime",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "`runtime` and `runtimes` agent tool-result middleware fields",
		docsPath: "/plugins/sdk-agent-harness",
		surfaces: [
			"AgentToolResultMiddlewareHarness",
			"AgentToolResultMiddlewareContext.harness",
			"AgentToolResultMiddlewareOptions.harnesses",
			"normalizeAgentToolResultMiddlewareHarnesses"
		],
		diagnostics: ["agent runtime compatibility warning"],
		tests: ["src/plugins/captured-registration.test.ts", "src/agents/codex-app-server.extensions.test.ts"]
	},
	{
		code: "runtime-config-load-write",
		status: "deprecated",
		owner: "sdk",
		introduced: "2026-04-27",
		deprecated: "2026-04-27",
		warningStarts: "2026-04-27",
		removeAfter: "2026-07-27",
		replacement: "`api.runtime.config.current()`, passed config values, `mutateConfigFile(...)`, or `replaceConfigFile(...)`",
		docsPath: "/plugins/sdk-runtime#config-loading-and-writes",
		surfaces: ["api.runtime.config.loadConfig", "api.runtime.config.writeConfigFile"],
		diagnostics: [
			"plugin runtime compatibility warning",
			"deprecated internal config API guard",
			"runtime channel config boundary guard"
		],
		tests: [
			"src/plugins/runtime/runtime-config.test.ts",
			"src/plugins/contracts/deprecated-internal-config-api.test.ts",
			"src/plugins/contracts/config-boundary-guard.test.ts"
		]
	},
	{
		code: "runtime-taskflow-legacy-alias",
		status: "deprecated",
		owner: "sdk",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "`api.runtime.tasks.managedFlows` for managed mutations or `api.runtime.tasks.flows` for DTO reads",
		docsPath: "/plugins/sdk-runtime",
		surfaces: ["api.runtime.taskFlow", "api.runtime.tasks.flow"],
		diagnostics: ["plugin runtime compatibility warning"],
		tests: ["src/plugins/runtime/index.test.ts", "src/plugins/runtime/runtime-tasks.test.ts"]
	},
	{
		code: "runtime-subagent-get-session-alias",
		status: "deprecated",
		owner: "sdk",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "`api.runtime.subagent.getSessionMessages`",
		docsPath: "/plugins/sdk-runtime",
		surfaces: ["api.runtime.subagent.getSession"],
		diagnostics: ["plugin runtime compatibility warning"],
		tests: ["src/plugins/runtime/index.test.ts"]
	},
	{
		code: "runtime-stt-alias",
		status: "deprecated",
		owner: "sdk",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "`api.runtime.mediaUnderstanding.transcribeAudioFile`",
		docsPath: "/plugins/sdk-runtime",
		surfaces: ["api.runtime.stt.transcribeAudioFile"],
		diagnostics: ["plugin runtime compatibility warning"],
		tests: ["src/plugins/runtime/index.test.ts"]
	},
	{
		code: "runtime-inbound-envelope-alias",
		status: "deprecated",
		owner: "channel",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "`BodyForAgent` plus structured user-context blocks",
		docsPath: "/plugins/sdk-runtime",
		surfaces: ["api.runtime.channel.reply.formatInboundEnvelope"],
		diagnostics: ["channel runtime compatibility warning"],
		tests: ["src/plugins/runtime/index.test.ts"]
	},
	{
		code: "channel-native-message-schema-helpers",
		status: "deprecated",
		owner: "channel",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "semantic `presentation` capabilities",
		docsPath: "/plugins/sdk-migration",
		surfaces: ["openclaw/plugin-sdk/channel-actions createMessageToolButtonsSchema", "openclaw/plugin-sdk/channel-actions createMessageToolCardSchema"],
		diagnostics: ["plugin SDK compatibility warning"],
		tests: ["src/plugins/contracts/plugin-sdk-subpaths.test.ts"]
	},
	{
		code: "channel-mention-gating-legacy-helpers",
		status: "deprecated",
		owner: "channel",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "`resolveInboundMentionDecision({ facts, policy })`",
		docsPath: "/plugins/sdk-migration",
		surfaces: [
			"openclaw/plugin-sdk/channel-inbound resolveMentionGating",
			"openclaw/plugin-sdk/channel-inbound resolveMentionGatingWithBypass",
			"openclaw/plugin-sdk/channel-mention-gating resolveMentionGating",
			"openclaw/plugin-sdk/channel-mention-gating resolveMentionGatingWithBypass"
		],
		diagnostics: ["plugin SDK compatibility warning"],
		tests: ["src/plugins/contracts/plugin-sdk-subpaths.test.ts"]
	},
	{
		code: "provider-web-search-core-wrapper",
		status: "deprecated",
		owner: "provider",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "provider-owned `createTool(...)` on the returned `WebSearchProviderPlugin`",
		docsPath: "/plugins/sdk-provider-plugins",
		surfaces: ["openclaw/plugin-sdk/provider-web-search createPluginBackedWebSearchProvider"],
		diagnostics: ["plugin SDK compatibility warning"],
		tests: ["src/plugins/contracts/plugin-sdk-subpaths.test.ts"]
	},
	{
		code: "approval-capability-approvals-alias",
		status: "deprecated",
		owner: "channel",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "top-level `delivery`, `nativeRuntime`, `render`, and `native` approval capability fields",
		docsPath: "/plugins/sdk-channel-plugins",
		surfaces: ["createChannelApprovalCapability({ approvals })"],
		diagnostics: ["plugin SDK compatibility warning"],
		tests: ["src/plugin-sdk/approval-delivery-helpers.test.ts"]
	},
	{
		code: "plugin-sdk-test-utils-alias",
		status: "deprecated",
		owner: "sdk",
		introduced: "2026-04-24",
		deprecated: "2026-04-26",
		warningStarts: "2026-04-26",
		removeAfter: "2026-07-26",
		replacement: "focused `openclaw/plugin-sdk/*` test subpaths",
		docsPath: "/plugins/sdk-migration",
		surfaces: ["openclaw/plugin-sdk/test-utils"],
		diagnostics: ["plugin SDK compatibility warning"],
		tests: ["src/plugins/compat/registry.test.ts", "src/plugins/contracts/plugin-sdk-subpaths.test.ts"]
	}
];
new Map(PLUGIN_COMPAT_RECORDS.map((record) => [record.code, record]));
function listPluginCompatRecords() {
	return PLUGIN_COMPAT_RECORDS;
}
//#endregion
//#region src/plugins/installed-plugin-index-hash.ts
function hashString(value) {
	return crypto.createHash("sha256").update(value).digest("hex");
}
function hashJson(value) {
	return hashString(JSON.stringify(value));
}
function safeHashFile(params) {
	try {
		return crypto.createHash("sha256").update(fs.readFileSync(params.filePath)).digest("hex");
	} catch (err) {
		if (params.required) params.diagnostics.push({
			level: "warn",
			...params.pluginId ? { pluginId: params.pluginId } : {},
			source: params.filePath,
			message: `installed plugin index could not hash ${params.filePath}: ${err instanceof Error ? err.message : String(err)}`
		});
		return;
	}
}
function safeFileSignature(filePath) {
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) return;
		return {
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			ctimeMs: stat.ctimeMs
		};
	} catch {
		return;
	}
}
function fileSignatureMatches(filePath, signature) {
	if (!signature) return;
	if (typeof signature.ctimeMs !== "number") return;
	const current = safeFileSignature(filePath);
	if (!current) return false;
	return current.size === signature.size && current.mtimeMs === signature.mtimeMs && current.ctimeMs === signature.ctimeMs;
}
//#endregion
//#region src/plugins/installed-plugin-index-policy.ts
function resolveCompatRegistryVersion() {
	return hashJson(listPluginCompatRecords().map((record) => ({
		code: record.code,
		status: record.status,
		deprecated: record.deprecated,
		warningStarts: record.warningStarts,
		removeAfter: record.removeAfter,
		replacement: record.replacement
	})));
}
function resolveInstalledPluginIndexPolicyHash(config) {
	const normalized = normalizePluginsConfig(config?.plugins);
	const channelPolicy = {};
	const channels = config?.channels;
	if (channels && typeof channels === "object" && !Array.isArray(channels)) {
		for (const [channelId, value] of Object.entries(channels)) if (value && typeof value === "object" && !Array.isArray(value)) {
			const enabled = value.enabled;
			if (typeof enabled === "boolean") channelPolicy[channelId] = enabled;
		}
	}
	return hashJson({
		plugins: {
			enabled: normalized.enabled,
			allow: normalized.allow,
			deny: normalized.deny,
			slots: normalized.slots,
			entries: Object.fromEntries(Object.entries(normalized.entries).flatMap(([pluginId, entry]) => typeof entry.enabled === "boolean" ? [[pluginId, entry.enabled]] : []).toSorted(([left], [right]) => left.localeCompare(right)))
		},
		channels: Object.fromEntries(Object.entries(channelPolicy).toSorted(([left], [right]) => left.localeCompare(right)))
	});
}
//#endregion
//#region src/plugins/default-enablement.ts
function isPluginEnabledByDefaultForPlatform(plugin, platform = process.platform) {
	if (plugin.enabledByDefault === true) return true;
	return plugin.enabledByDefaultOnPlatforms?.includes(platform) === true;
}
//#endregion
//#region src/plugins/installed-plugin-index-install-records.ts
function setInstallStringField(target, key, value) {
	if (typeof value !== "string") return;
	const normalized = value.trim();
	if (normalized) target[key] = normalized;
}
function setInstallNumberField(target, key, value) {
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) target[key] = value;
}
function normalizeInstallRecord(record) {
	if (!record) return;
	const normalized = { source: record.source };
	setInstallStringField(normalized, "spec", record.spec);
	setInstallStringField(normalized, "sourcePath", record.sourcePath);
	setInstallStringField(normalized, "installPath", record.installPath);
	setInstallStringField(normalized, "version", record.version);
	setInstallStringField(normalized, "resolvedName", record.resolvedName);
	setInstallStringField(normalized, "resolvedVersion", record.resolvedVersion);
	setInstallStringField(normalized, "resolvedSpec", record.resolvedSpec);
	setInstallStringField(normalized, "integrity", record.integrity);
	setInstallStringField(normalized, "shasum", record.shasum);
	setInstallStringField(normalized, "resolvedAt", record.resolvedAt);
	setInstallStringField(normalized, "installedAt", record.installedAt);
	setInstallStringField(normalized, "clawhubUrl", record.clawhubUrl);
	setInstallStringField(normalized, "clawhubPackage", record.clawhubPackage);
	setInstallStringField(normalized, "clawhubFamily", record.clawhubFamily);
	setInstallStringField(normalized, "clawhubChannel", record.clawhubChannel);
	setInstallStringField(normalized, "artifactKind", record.artifactKind);
	setInstallStringField(normalized, "artifactFormat", record.artifactFormat);
	setInstallStringField(normalized, "npmIntegrity", record.npmIntegrity);
	setInstallStringField(normalized, "npmShasum", record.npmShasum);
	setInstallStringField(normalized, "npmTarballName", record.npmTarballName);
	setInstallStringField(normalized, "clawpackSha256", record.clawpackSha256);
	setInstallNumberField(normalized, "clawpackSpecVersion", record.clawpackSpecVersion);
	setInstallStringField(normalized, "clawpackManifestSha256", record.clawpackManifestSha256);
	setInstallNumberField(normalized, "clawpackSize", record.clawpackSize);
	setInstallStringField(normalized, "gitUrl", record.gitUrl);
	setInstallStringField(normalized, "gitRef", record.gitRef);
	setInstallStringField(normalized, "gitCommit", record.gitCommit);
	setInstallStringField(normalized, "marketplaceName", record.marketplaceName);
	setInstallStringField(normalized, "marketplaceSource", record.marketplaceSource);
	setInstallStringField(normalized, "marketplacePlugin", record.marketplacePlugin);
	return normalized;
}
function restoreInstallRecord(record) {
	if (!record?.source) return;
	return structuredClone(record);
}
function normalizeInstallRecordMap(records) {
	const normalized = {};
	for (const [pluginId, record] of Object.entries(records ?? {}).toSorted(([left], [right]) => left.localeCompare(right))) {
		const installRecord = normalizeInstallRecord(record);
		if (installRecord) normalized[pluginId] = installRecord;
	}
	return normalized;
}
function restoreInstallRecordMap(records) {
	const restored = {};
	for (const [pluginId, record] of Object.entries(records ?? {}).toSorted(([left], [right]) => left.localeCompare(right))) {
		const installRecord = restoreInstallRecord(record);
		if (installRecord) restored[pluginId] = installRecord;
	}
	return restored;
}
function extractPluginInstallRecordsFromInstalledPluginIndex(index) {
	if (index && Object.prototype.hasOwnProperty.call(index, "installRecords")) return restoreInstallRecordMap(index.installRecords);
	const records = {};
	for (const plugin of index?.plugins ?? []) {
		const record = restoreInstallRecord(plugin.installRecord);
		if (record) records[plugin.pluginId] = record;
	}
	return records;
}
//#endregion
//#region src/plugins/installed-plugin-index-manifest.ts
function hasOptionalMissingPluginManifestFile(record) {
	return record.format === "bundle" && record.bundleFormat === "claude" && !fs.existsSync(record.manifestPath);
}
//#endregion
//#region src/plugins/installed-plugin-index-record-builder.ts
function sortUnique(values) {
	if (!values || values.length === 0) return [];
	return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).toSorted((left, right) => left.localeCompare(right));
}
function buildStartupInfo(record) {
	return {
		sidecar: record.activation?.onStartup === true,
		memory: hasKind(record.kind, "memory"),
		deferConfiguredChannelFullLoadUntilAfterListen: record.startupDeferConfiguredChannelFullLoadUntilAfterListen === true,
		agentHarnesses: sortUnique([...record.activation?.onAgentHarnesses ?? [], ...record.cliBackends ?? []])
	};
}
function collectPluginManifestCompatCodes(record) {
	const codes = [];
	if (record.providerAuthEnvVars && Object.keys(record.providerAuthEnvVars).length > 0) codes.push("provider-auth-env-vars");
	if (record.channelEnvVars && Object.keys(record.channelEnvVars).length > 0) codes.push("channel-env-vars");
	if (record.activation?.onProviders?.length) codes.push("activation-provider-hint");
	if (record.activation?.onAgentHarnesses?.length) codes.push("activation-agent-harness-hint");
	if (record.activation?.onChannels?.length) codes.push("activation-channel-hint");
	if (record.activation?.onCommands?.length) codes.push("activation-command-hint");
	if (record.activation?.onRoutes?.length) codes.push("activation-route-hint");
	if (record.activation?.onConfigPaths?.length) codes.push("activation-config-path-hint");
	if (record.activation?.onCapabilities?.length) codes.push("activation-capability-hint");
	return sortUnique(codes);
}
function resolvePackageJsonPath(candidate) {
	if (!candidate?.packageDir) return;
	const packageDir = safeRealpathSync(candidate.packageDir) ?? path.resolve(candidate.packageDir);
	const packageJsonPath = path.join(packageDir, "package.json");
	return fs.existsSync(packageJsonPath) ? packageJsonPath : void 0;
}
function resolvePackageJsonRelativePath(rootDir, packageJsonPath) {
	const resolvedRootDir = safeRealpathSync(rootDir) ?? path.resolve(rootDir);
	return (path.relative(resolvedRootDir, packageJsonPath) || "package.json").split(path.sep).join("/");
}
function resolvePackageJsonRecord(params) {
	if (!params.candidate?.packageDir || !params.packageJsonPath) return;
	const hash = safeHashFile({
		filePath: params.packageJsonPath,
		pluginId: params.pluginId,
		diagnostics: params.diagnostics,
		required: false
	});
	if (!hash) return;
	const fileSignature = safeFileSignature(params.packageJsonPath);
	return {
		path: resolvePackageJsonRelativePath(params.candidate.rootDir, params.packageJsonPath),
		hash,
		...fileSignature ? { fileSignature } : {}
	};
}
function describePackageInstallSource(candidate) {
	const install = candidate?.packageManifest?.install;
	if (!install) return;
	return describePluginInstallSource(install, { expectedPackageName: candidate?.packageName });
}
function normalizeStringField(value) {
	if (typeof value !== "string") return;
	const normalized = value.trim();
	return normalized ? normalized : void 0;
}
function normalizePackageChannel(channel) {
	const id = normalizeStringField(channel?.id);
	if (!id) return;
	return {
		...structuredClone(channel),
		id
	};
}
function hashManifestlessBundleRecord(record) {
	return hashJson({
		id: record.id,
		name: record.name,
		description: record.description,
		version: record.version,
		format: record.format,
		bundleFormat: record.bundleFormat,
		bundleCapabilities: record.bundleCapabilities ?? [],
		skills: record.skills ?? [],
		settingsFiles: record.settingsFiles ?? [],
		hooks: record.hooks ?? []
	});
}
function resolveManifestHash(params) {
	if (hasOptionalMissingPluginManifestFile(params.record)) return hashManifestlessBundleRecord(params.record);
	const hash = safeHashFile({
		filePath: params.record.manifestPath,
		pluginId: params.record.id,
		diagnostics: params.diagnostics,
		required: true
	});
	if (hash) return hash;
	return "";
}
function buildCandidateLookup(candidates) {
	const byRootDir = /* @__PURE__ */ new Map();
	for (const candidate of candidates) byRootDir.set(candidate.rootDir, candidate);
	return byRootDir;
}
function buildInstalledPluginIndexRecords(params) {
	const candidateByRootDir = buildCandidateLookup(params.candidates);
	const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
	return params.registry.plugins.map((record) => {
		const candidate = candidateByRootDir.get(record.rootDir);
		const packageJsonPath = resolvePackageJsonPath(candidate);
		const installRecord = params.installRecords[record.id];
		const packageInstall = describePackageInstallSource(candidate);
		const packageChannel = normalizePackageChannel(record.packageChannel ?? candidate?.packageManifest?.channel);
		const manifestHash = resolveManifestHash({
			record,
			diagnostics: params.diagnostics
		});
		const manifestFile = hasOptionalMissingPluginManifestFile(record) ? void 0 : safeFileSignature(record.manifestPath);
		const packageJson = resolvePackageJsonRecord({
			candidate,
			packageJsonPath,
			diagnostics: params.diagnostics,
			pluginId: record.id
		});
		const enabled = resolveEffectiveEnableState({
			id: record.id,
			origin: record.origin,
			config: normalizedConfig,
			rootConfig: params.config,
			enabledByDefault: isPluginEnabledByDefaultForPlatform(record)
		}).enabled;
		const indexRecord = {
			pluginId: record.id,
			manifestPath: record.manifestPath,
			manifestHash,
			...manifestFile ? { manifestFile } : {},
			source: record.source,
			rootDir: record.rootDir,
			origin: record.origin,
			enabled,
			startup: buildStartupInfo(record),
			compat: collectPluginManifestCompatCodes(record)
		};
		if (record.format && record.format !== "openclaw") indexRecord.format = record.format;
		if (record.bundleFormat) indexRecord.bundleFormat = record.bundleFormat;
		if (record.enabledByDefault === true) indexRecord.enabledByDefault = true;
		if (record.enabledByDefaultOnPlatforms?.length) indexRecord.enabledByDefaultOnPlatforms = [...record.enabledByDefaultOnPlatforms];
		if (record.syntheticAuthRefs?.length) indexRecord.syntheticAuthRefs = [...record.syntheticAuthRefs];
		if (record.setupSource) indexRecord.setupSource = record.setupSource;
		if (candidate?.packageName) indexRecord.packageName = candidate.packageName;
		if (candidate?.packageVersion) indexRecord.packageVersion = candidate.packageVersion;
		if (installRecord) indexRecord.installRecordHash = hashJson(installRecord);
		if (packageInstall) indexRecord.packageInstall = packageInstall;
		if (packageChannel) indexRecord.packageChannel = packageChannel;
		if (packageJson) indexRecord.packageJson = packageJson;
		return indexRecord;
	});
}
//#endregion
//#region src/plugins/installed-plugin-index-registry.ts
function resolveInstalledPluginIndexRegistry(params) {
	if (params.candidates) return {
		candidates: params.candidates,
		registry: loadPluginManifestRegistry({
			config: params.config,
			workspaceDir: params.workspaceDir,
			env: params.env,
			candidates: params.candidates,
			diagnostics: params.diagnostics,
			installRecords: params.installRecords
		})
	};
	const normalized = normalizePluginsConfig(params.config?.plugins);
	const installRecords = params.installRecords ?? loadInstalledPluginIndexInstallRecordsSync({ env: params.env });
	const discovery = discoverOpenClawPlugins({
		workspaceDir: params.workspaceDir,
		extraPaths: normalized.loadPaths,
		env: params.env,
		installRecords
	});
	return {
		candidates: discovery.candidates,
		registry: loadPluginManifestRegistry({
			config: params.config,
			workspaceDir: params.workspaceDir,
			env: params.env,
			candidates: discovery.candidates,
			diagnostics: discovery.diagnostics,
			installRecords
		})
	};
}
//#endregion
//#region src/plugins/installed-plugin-index-types.ts
const INSTALLED_PLUGIN_INDEX_WARNING = "DO NOT EDIT. This file is generated by OpenClaw from plugin manifests, install records, and config policy. Use `openclaw plugins registry --refresh`, `openclaw plugins install/update/uninstall`, or `openclaw plugins enable/disable` instead.";
//#endregion
//#region src/plugins/installed-plugin-index-invalidation.ts
function diffInstalledPluginIndexInvalidationReasons(previous, current) {
	const reasons = /* @__PURE__ */ new Set();
	if (previous.version !== current.version) reasons.add("missing");
	if (previous.hostContractVersion !== current.hostContractVersion) reasons.add("host-contract-changed");
	if (previous.compatRegistryVersion !== current.compatRegistryVersion) reasons.add("compat-registry-changed");
	if (previous.migrationVersion !== current.migrationVersion) reasons.add("migration");
	if (previous.policyHash !== current.policyHash) reasons.add("policy-changed");
	if (hashJson(previous.installRecords ?? {}) !== hashJson(current.installRecords ?? {})) reasons.add("source-changed");
	const previousByPluginId = new Map(previous.plugins.map((plugin) => [plugin.pluginId, plugin]));
	const currentByPluginId = new Map(current.plugins.map((plugin) => [plugin.pluginId, plugin]));
	for (const [pluginId, previousPlugin] of previousByPluginId) {
		const currentPlugin = currentByPluginId.get(pluginId);
		if (!currentPlugin) {
			reasons.add("source-changed");
			continue;
		}
		if (previousPlugin.rootDir !== currentPlugin.rootDir || previousPlugin.manifestPath !== currentPlugin.manifestPath || previousPlugin.installRecordHash !== currentPlugin.installRecordHash) reasons.add("source-changed");
		if (previousPlugin.enabled !== currentPlugin.enabled) reasons.add("policy-changed");
		if (previousPlugin.manifestHash !== currentPlugin.manifestHash) reasons.add("stale-manifest");
		if (previousPlugin.packageVersion !== currentPlugin.packageVersion || previousPlugin.packageJson?.path !== currentPlugin.packageJson?.path || previousPlugin.packageJson?.hash !== currentPlugin.packageJson?.hash) reasons.add("stale-package");
	}
	for (const pluginId of currentByPluginId.keys()) if (!previousByPluginId.has(pluginId)) {
		if (currentByPluginId.get(pluginId)?.enabled === false) continue;
		reasons.add("source-changed");
	}
	return Array.from(reasons).toSorted((left, right) => left.localeCompare(right));
}
//#endregion
//#region src/plugins/installed-plugin-index.ts
function buildInstalledPluginIndex(params) {
	const env = params.env ?? process.env;
	const { candidates, registry } = resolveInstalledPluginIndexRegistry(params);
	const diagnostics = [...registry.diagnostics ?? []];
	const generatedAtMs = (params.now?.() ?? /* @__PURE__ */ new Date()).getTime();
	const installRecords = normalizeInstallRecordMap(params.installRecords ?? loadInstalledPluginIndexInstallRecordsSync({
		env,
		...params.stateDir ? { stateDir: params.stateDir } : {},
		...params.pluginIndexFilePath ? { filePath: params.pluginIndexFilePath } : {}
	}));
	const plugins = buildInstalledPluginIndexRecords({
		candidates,
		registry,
		config: params.config,
		diagnostics,
		installRecords
	});
	return {
		version: 1,
		warning: INSTALLED_PLUGIN_INDEX_WARNING,
		hostContractVersion: resolveCompatibilityHostVersion(env),
		compatRegistryVersion: resolveCompatRegistryVersion(),
		migrationVersion: 1,
		policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
		generatedAtMs,
		...params.refreshReason ? { refreshReason: params.refreshReason } : {},
		installRecords,
		plugins,
		diagnostics
	};
}
function loadInstalledPluginIndex(params = {}) {
	return buildInstalledPluginIndex(params);
}
function refreshInstalledPluginIndex(params) {
	return buildInstalledPluginIndex({
		...params,
		refreshReason: params.reason
	});
}
function getInstalledPluginRecord(index, pluginId) {
	return index.plugins.find((plugin) => plugin.pluginId === pluginId);
}
function isInstalledPluginEnabled(index, pluginId, config) {
	const record = getInstalledPluginRecord(index, pluginId);
	if (!record) return false;
	if (!config) return record.enabled;
	const normalizedConfig = normalizePluginsConfig(config?.plugins);
	const state = resolveEffectivePluginActivationState({
		id: record.pluginId,
		origin: record.origin,
		config: normalizedConfig,
		rootConfig: config,
		enabledByDefault: isPluginEnabledByDefaultForPlatform(record)
	});
	return state.enabled && (record.enabled || state.explicitlyEnabled);
}
//#endregion
//#region src/plugins/current-plugin-metadata-state.ts
let currentPluginMetadataSnapshot;
let currentPluginMetadataSnapshotConfigFingerprint;
function setCurrentPluginMetadataSnapshotState(snapshot, configFingerprint) {
	currentPluginMetadataSnapshot = snapshot;
	currentPluginMetadataSnapshotConfigFingerprint = snapshot ? configFingerprint : void 0;
}
function clearCurrentPluginMetadataSnapshotState() {
	currentPluginMetadataSnapshot = void 0;
	currentPluginMetadataSnapshotConfigFingerprint = void 0;
}
function getCurrentPluginMetadataSnapshotState() {
	return {
		snapshot: currentPluginMetadataSnapshot,
		configFingerprint: currentPluginMetadataSnapshotConfigFingerprint
	};
}
//#endregion
//#region src/plugins/installed-plugin-index-store.ts
const StringArraySchema = z.array(z.string());
const InstalledPluginIndexStartupSchema = z.object({
	sidecar: z.boolean(),
	memory: z.boolean(),
	deferConfiguredChannelFullLoadUntilAfterListen: z.boolean(),
	agentHarnesses: StringArraySchema
});
const InstalledPluginFileSignatureSchema = z.object({
	size: z.number(),
	mtimeMs: z.number(),
	ctimeMs: z.number().optional()
});
const InstalledPluginIndexRecordSchema = z.object({
	pluginId: z.string(),
	packageName: z.string().optional(),
	packageVersion: z.string().optional(),
	installRecord: z.record(z.string(), z.unknown()).optional(),
	installRecordHash: z.string().optional(),
	packageInstall: z.unknown().optional(),
	packageChannel: z.unknown().optional(),
	manifestPath: z.string(),
	manifestHash: z.string(),
	manifestFile: InstalledPluginFileSignatureSchema.optional(),
	format: z.string().optional(),
	bundleFormat: z.string().optional(),
	source: z.string().optional(),
	setupSource: z.string().optional(),
	packageJson: z.object({
		path: z.string(),
		hash: z.string(),
		fileSignature: InstalledPluginFileSignatureSchema.optional()
	}).optional(),
	rootDir: z.string(),
	origin: z.string(),
	enabled: z.boolean(),
	enabledByDefault: z.boolean().optional(),
	enabledByDefaultOnPlatforms: StringArraySchema.optional(),
	syntheticAuthRefs: StringArraySchema.optional(),
	startup: InstalledPluginIndexStartupSchema,
	compat: z.array(z.string())
});
const InstalledPluginInstallRecordSchema = z.record(z.string(), z.unknown());
const PluginDiagnosticSchema = z.object({
	level: z.union([z.literal("warn"), z.literal("error")]),
	message: z.string(),
	pluginId: z.string().optional(),
	source: z.string().optional()
});
const InstalledPluginIndexSchema = z.object({
	version: z.literal(1),
	warning: z.string().optional(),
	hostContractVersion: z.string(),
	compatRegistryVersion: z.string(),
	migrationVersion: z.literal(1),
	policyHash: z.string(),
	generatedAtMs: z.number(),
	refreshReason: z.string().optional(),
	installRecords: z.record(z.string(), InstalledPluginInstallRecordSchema).optional(),
	plugins: z.array(InstalledPluginIndexRecordSchema),
	diagnostics: z.array(PluginDiagnosticSchema)
});
function copySafeInstallRecords(records) {
	if (!records) return;
	const safeRecords = {};
	for (const [pluginId, record] of Object.entries(records)) {
		if (isBlockedObjectKey(pluginId)) continue;
		safeRecords[pluginId] = record;
	}
	return safeRecords;
}
function parseInstalledPluginIndex(value) {
	const parsed = safeParseWithSchema(InstalledPluginIndexSchema, value);
	if (!parsed) return null;
	const installRecords = copySafeInstallRecords(parsed.installRecords) ?? copySafeInstallRecords(extractPluginInstallRecordsFromInstalledPluginIndex(parsed)) ?? {};
	return {
		version: parsed.version,
		...parsed.warning ? { warning: parsed.warning } : {},
		hostContractVersion: parsed.hostContractVersion,
		compatRegistryVersion: parsed.compatRegistryVersion,
		migrationVersion: parsed.migrationVersion,
		policyHash: parsed.policyHash,
		generatedAtMs: parsed.generatedAtMs,
		...parsed.refreshReason ? { refreshReason: parsed.refreshReason } : {},
		installRecords,
		plugins: parsed.plugins,
		diagnostics: parsed.diagnostics
	};
}
async function readPersistedInstalledPluginIndex(options = {}) {
	return parseInstalledPluginIndex(await readJsonFile(resolveInstalledPluginIndexStorePath(options)));
}
function readPersistedInstalledPluginIndexSync(options = {}) {
	return parseInstalledPluginIndex(readJsonFileSync(resolveInstalledPluginIndexStorePath(options)));
}
async function writePersistedInstalledPluginIndex(index, options = {}) {
	const filePath = resolveInstalledPluginIndexStorePath(options);
	await writeJsonAtomic(filePath, {
		...index,
		warning: INSTALLED_PLUGIN_INDEX_WARNING
	}, {
		trailingNewline: true,
		ensureDirMode: 448,
		mode: 384
	});
	clearCurrentPluginMetadataSnapshotState();
	return filePath;
}
function writePersistedInstalledPluginIndexSync(index, options = {}) {
	const filePath = resolveInstalledPluginIndexStorePath(options);
	saveJsonFile(filePath, {
		...index,
		warning: INSTALLED_PLUGIN_INDEX_WARNING
	});
	clearCurrentPluginMetadataSnapshotState();
	return filePath;
}
function hasPolicyRefreshTargets(persisted, policyPluginIds) {
	if (!policyPluginIds || policyPluginIds.length === 0) return true;
	const pluginIds = new Set(persisted.plugins.map((plugin) => plugin.pluginId));
	return policyPluginIds.every((pluginId) => pluginIds.has(pluginId));
}
function canRefreshPersistedPolicyState(persisted, params) {
	if (!persisted || params.reason !== "policy-changed") return false;
	const env = params.env ?? process.env;
	if (persisted.version !== 1 || persisted.hostContractVersion !== resolveCompatibilityHostVersion(env) || persisted.compatRegistryVersion !== resolveCompatRegistryVersion() || persisted.migrationVersion !== 1) return false;
	if (params.installRecords && hashJson(params.installRecords) !== hashJson(persisted.installRecords ?? {})) return false;
	return hasPolicyRefreshTargets(persisted, params.policyPluginIds);
}
function refreshPersistedPolicyState(persisted, params) {
	const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
	return {
		...persisted,
		policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
		generatedAtMs: (params.now?.() ?? /* @__PURE__ */ new Date()).getTime(),
		refreshReason: params.reason,
		plugins: persisted.plugins.map((plugin) => ({
			...plugin,
			enabled: resolveEffectiveEnableState({
				id: plugin.pluginId,
				origin: plugin.origin,
				config: normalizedConfig,
				rootConfig: params.config,
				enabledByDefault: isPluginEnabledByDefaultForPlatform(plugin)
			}).enabled
		}))
	};
}
async function inspectPersistedInstalledPluginIndex(params = {}) {
	const persisted = await readPersistedInstalledPluginIndex(params);
	const current = loadInstalledPluginIndex({
		...params,
		installRecords: params.installRecords ?? extractPluginInstallRecordsFromInstalledPluginIndex(persisted)
	});
	if (!persisted) return {
		state: "missing",
		refreshReasons: ["missing"],
		persisted: null,
		current
	};
	const refreshReasons = diffInstalledPluginIndexInvalidationReasons(persisted, current);
	return {
		state: refreshReasons.length > 0 ? "stale" : "fresh",
		refreshReasons,
		persisted,
		current
	};
}
async function refreshPersistedInstalledPluginIndex(params) {
	const persisted = params.reason === "policy-changed" || !params.installRecords ? await readPersistedInstalledPluginIndex(params) : null;
	if (canRefreshPersistedPolicyState(persisted, params)) {
		const index = refreshPersistedPolicyState(persisted, params);
		await writePersistedInstalledPluginIndex(index, params);
		return index;
	}
	const index = refreshInstalledPluginIndex({
		...params,
		installRecords: params.installRecords ?? extractPluginInstallRecordsFromInstalledPluginIndex(persisted)
	});
	await writePersistedInstalledPluginIndex(index, params);
	return index;
}
function refreshPersistedInstalledPluginIndexSync(params) {
	const persisted = params.reason === "policy-changed" || !params.installRecords ? readPersistedInstalledPluginIndexSync(params) : null;
	if (canRefreshPersistedPolicyState(persisted, params)) {
		const index = refreshPersistedPolicyState(persisted, params);
		writePersistedInstalledPluginIndexSync(index, params);
		return index;
	}
	const index = refreshInstalledPluginIndex({
		...params,
		installRecords: params.installRecords ?? extractPluginInstallRecordsFromInstalledPluginIndex(persisted)
	});
	writePersistedInstalledPluginIndexSync(index, params);
	return index;
}
//#endregion
export { resolveInstalledPluginIndexPolicyHash as _, refreshPersistedInstalledPluginIndexSync as a, getCurrentPluginMetadataSnapshotState as c, isInstalledPluginEnabled as d, loadInstalledPluginIndex as f, isPluginEnabledByDefaultForPlatform as g, extractPluginInstallRecordsFromInstalledPluginIndex as h, refreshPersistedInstalledPluginIndex as i, setCurrentPluginMetadataSnapshotState as l, hasOptionalMissingPluginManifestFile as m, readPersistedInstalledPluginIndex as n, writePersistedInstalledPluginIndex as o, collectPluginManifestCompatCodes as p, readPersistedInstalledPluginIndexSync as r, clearCurrentPluginMetadataSnapshotState as s, inspectPersistedInstalledPluginIndex as t, getInstalledPluginRecord as u, fileSignatureMatches as v, hashJson as y };
