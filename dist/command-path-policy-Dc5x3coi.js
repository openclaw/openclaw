import { D as isValueToken, c as hasFlag, n as getCommandPathWithRootOptions } from "./argv-j42r4Rb7.js";
import { n as isGatewayConfigBypassCommandPath } from "./explicit-connection-policy-BAf1LVDv.js";
//#region src/cli/gateway-run-argv.ts
const GATEWAY_RUN_VALUE_FLAGS = new Set([
	"--port",
	"--bind",
	"--token",
	"--auth",
	"--password",
	"--password-file",
	"--tailscale",
	"--ws-log",
	"--raw-stream-path"
]);
const GATEWAY_RUN_BOOLEAN_FLAGS = new Set([
	"--tailscale-reset-on-exit",
	"--allow-unconfigured",
	"--dev",
	"--reset",
	"--force",
	"--verbose",
	"--cli-backend-logs",
	"--claude-cli-logs",
	"--compact",
	"--raw-stream"
]);
function consumeGatewayRunOptionToken(args, index) {
	const arg = args[index];
	if (!arg || arg === "--" || !arg.startsWith("-")) return 0;
	const equalsIndex = arg.indexOf("=");
	const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
	if (GATEWAY_RUN_BOOLEAN_FLAGS.has(flag)) return equalsIndex === -1 ? 1 : 0;
	if (!GATEWAY_RUN_VALUE_FLAGS.has(flag)) return 0;
	if (equalsIndex !== -1) return arg.slice(equalsIndex + 1).trim() ? 1 : 0;
	return isValueToken(args[index + 1]) ? 2 : 0;
}
function consumeGatewayFastPathRootOptionToken(args, index) {
	const arg = args[index];
	if (!arg || arg === "--") return 0;
	if (arg === "--no-color") return 1;
	if (arg.startsWith("--profile=")) return arg.slice(10).trim() ? 1 : 0;
	if (arg === "--profile") return isValueToken(args[index + 1]) ? 2 : 0;
	return 0;
}
function resolveGatewayCatalogCommandPath(argv) {
	const args = argv.slice(2);
	let sawGateway = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (!arg || arg === "--") break;
		if (!sawGateway) {
			const consumed = consumeGatewayFastPathRootOptionToken(args, index);
			if (consumed > 0) {
				index += consumed - 1;
				continue;
			}
			if (arg.startsWith("-")) continue;
			if (arg !== "gateway") return null;
			sawGateway = true;
			continue;
		}
		const consumed = consumeGatewayRunOptionToken(args, index);
		if (consumed > 0) {
			index += consumed - 1;
			continue;
		}
		if (arg.startsWith("-")) continue;
		return ["gateway", arg];
	}
	return sawGateway ? ["gateway"] : null;
}
//#endregion
//#region src/cli/command-catalog.ts
const cliCommandCatalog = [
	{
		commandPath: ["crestodian"],
		policy: {
			bypassConfigGuard: true,
			loadPlugins: "never",
			ensureCliPath: false
		}
	},
	{
		commandPath: ["agent"],
		policy: {
			loadPlugins: ({ argv, jsonOutputMode }) => hasFlag(argv, "--local") || !jsonOutputMode,
			pluginRegistry: { scope: "all" },
			networkProxy: ({ argv }) => hasFlag(argv, "--local") ? "default" : "bypass"
		}
	},
	{
		commandPath: ["message"],
		policy: { loadPlugins: "never" }
	},
	{
		commandPath: ["channels"],
		policy: {
			loadPlugins: "always",
			pluginRegistry: { scope: "configured-channels" }
		}
	},
	{
		commandPath: ["directory"],
		policy: { loadPlugins: "always" }
	},
	{
		commandPath: ["agents"],
		policy: {
			loadPlugins: "always",
			networkProxy: "bypass"
		}
	},
	{
		commandPath: ["agents"],
		exact: true,
		policy: {
			loadPlugins: "never",
			networkProxy: "bypass"
		},
		route: { id: "agents-list" }
	},
	{
		commandPath: ["agents", "bind"],
		exact: true,
		policy: { loadPlugins: "never" }
	},
	{
		commandPath: ["agents", "bindings"],
		exact: true,
		policy: { loadPlugins: "never" }
	},
	{
		commandPath: ["agents", "unbind"],
		exact: true,
		policy: { loadPlugins: "never" }
	},
	{
		commandPath: ["agents", "set-identity"],
		exact: true,
		policy: { loadPlugins: "never" }
	},
	{
		commandPath: ["agents", "delete"],
		exact: true,
		policy: { loadPlugins: "never" }
	},
	{
		commandPath: ["configure"],
		policy: {
			bypassConfigGuard: true,
			loadPlugins: "never"
		}
	},
	{
		commandPath: ["config"],
		exact: true,
		policy: {
			bypassConfigGuard: true,
			loadPlugins: "never",
			networkProxy: "bypass"
		}
	},
	{
		commandPath: ["config", "models"],
		exact: true,
		policy: {
			bypassConfigGuard: true,
			loadPlugins: "never",
			networkProxy: "bypass"
		}
	},
	{
		commandPath: ["migrate"],
		policy: {
			bypassConfigGuard: true,
			loadPlugins: "never",
			networkProxy: "bypass"
		}
	},
	{
		commandPath: ["status"],
		policy: {
			loadPlugins: "never",
			pluginRegistry: { scope: "channels" },
			routeConfigGuard: "when-suppressed",
			ensureCliPath: false,
			networkProxy: "bypass"
		},
		route: { id: "status" }
	},
	{
		commandPath: ["health"],
		policy: {
			loadPlugins: "never",
			pluginRegistry: { scope: "channels" },
			ensureCliPath: false,
			networkProxy: "bypass"
		},
		route: { id: "health" }
	},
	{
		commandPath: ["gateway"],
		policy: { networkProxy: ({ commandPath }) => commandPath.length === 1 || commandPath[1] === "run" ? "default" : "bypass" }
	},
	{
		commandPath: ["gateway", "status"],
		exact: true,
		policy: {
			routeConfigGuard: "always",
			loadPlugins: "never",
			networkProxy: "bypass"
		},
		route: { id: "gateway-status" }
	},
	{
		commandPath: ["gateway", "call"],
		exact: true,
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["gateway", "diagnostics"],
		exact: true,
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["gateway", "discover"],
		exact: true,
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["gateway", "export"],
		exact: true,
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["gateway", "health"],
		exact: true,
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["gateway", "install"],
		exact: true,
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["gateway", "probe"],
		exact: true,
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["gateway", "restart"],
		exact: true,
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["gateway", "stability"],
		exact: true,
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["gateway", "start"],
		exact: true,
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["gateway", "stop"],
		exact: true,
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["gateway", "uninstall"],
		exact: true,
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["gateway", "usage-cost"],
		exact: true,
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["sessions"],
		exact: true,
		policy: {
			ensureCliPath: false,
			networkProxy: "bypass"
		},
		route: { id: "sessions" }
	},
	{
		commandPath: ["commitments"],
		policy: {
			ensureCliPath: false,
			routeConfigGuard: "when-suppressed",
			loadPlugins: "never",
			networkProxy: "bypass"
		}
	},
	{
		commandPath: ["agents", "list"],
		policy: {
			loadPlugins: "never",
			networkProxy: "bypass"
		},
		route: { id: "agents-list" }
	},
	{
		commandPath: ["config", "get"],
		exact: true,
		policy: {
			ensureCliPath: false,
			networkProxy: "bypass"
		},
		route: { id: "config-get" }
	},
	{
		commandPath: ["config", "unset"],
		exact: true,
		policy: {
			ensureCliPath: false,
			networkProxy: "bypass"
		},
		route: { id: "config-unset" }
	},
	{
		commandPath: ["models", "list"],
		exact: true,
		policy: {
			ensureCliPath: false,
			routeConfigGuard: "always",
			networkProxy: "bypass"
		},
		route: { id: "models-list" }
	},
	{
		commandPath: ["models", "status"],
		exact: true,
		policy: {
			ensureCliPath: false,
			routeConfigGuard: "always",
			networkProxy: ({ argv }) => hasFlag(argv, "--probe") ? "default" : "bypass"
		},
		route: { id: "models-status" }
	},
	{
		commandPath: ["tasks", "list"],
		exact: true,
		policy: {
			ensureCliPath: false,
			routeConfigGuard: "when-suppressed",
			loadPlugins: "never",
			networkProxy: "bypass"
		},
		route: { id: "tasks-list" }
	},
	{
		commandPath: ["tasks", "audit"],
		exact: true,
		policy: {
			ensureCliPath: false,
			routeConfigGuard: "when-suppressed",
			loadPlugins: "never",
			networkProxy: "bypass"
		},
		route: { id: "tasks-audit" }
	},
	{
		commandPath: ["tasks"],
		policy: {
			ensureCliPath: false,
			routeConfigGuard: "when-suppressed",
			loadPlugins: "never",
			networkProxy: "bypass"
		},
		route: { id: "tasks-list" }
	},
	{
		commandPath: ["tool"],
		policy: {
			loadPlugins: "never",
			ensureCliPath: false,
			networkProxy: "bypass"
		}
	},
	{
		commandPath: ["tools"],
		policy: {
			loadPlugins: "never",
			ensureCliPath: false,
			networkProxy: "bypass"
		}
	},
	{
		commandPath: ["acp"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["approvals"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["backup"],
		policy: {
			bypassConfigGuard: true,
			networkProxy: "bypass"
		}
	},
	{
		commandPath: ["chat"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["config"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["cron"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["dashboard"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["daemon"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["devices"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["doctor"],
		policy: {
			bypassConfigGuard: true,
			loadPlugins: "never"
		}
	},
	{
		commandPath: ["exec-policy"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["hooks"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["logs"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["mcp"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["node"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["node", "run"],
		exact: true,
		policy: { networkProxy: "default" }
	},
	{
		commandPath: ["nodes"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["pairing"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["proxy"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["qr"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["reset"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["completion"],
		policy: {
			bypassConfigGuard: true,
			hideBanner: true,
			networkProxy: "bypass"
		}
	},
	{
		commandPath: ["secrets"],
		policy: {
			bypassConfigGuard: true,
			networkProxy: "bypass"
		}
	},
	{
		commandPath: ["security"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["system"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["terminal"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["tui"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["uninstall"],
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["update"],
		policy: { hideBanner: true }
	},
	{
		commandPath: ["config", "validate"],
		exact: true,
		policy: {
			bypassConfigGuard: true,
			networkProxy: "bypass"
		}
	},
	{
		commandPath: ["config", "schema"],
		exact: true,
		policy: {
			bypassConfigGuard: true,
			networkProxy: "bypass"
		}
	},
	{
		commandPath: ["plugins", "update"],
		exact: true,
		policy: { hideBanner: true }
	},
	{
		commandPath: ["plugins", "list"],
		exact: true,
		policy: {
			ensureCliPath: false,
			loadPlugins: "never",
			networkProxy: "bypass"
		},
		route: { id: "plugins-list" }
	},
	{
		commandPath: ["onboard"],
		exact: true,
		policy: { loadPlugins: "never" }
	},
	{
		commandPath: ["channels", "add"],
		exact: true,
		policy: {
			loadPlugins: "never",
			networkProxy: "bypass"
		}
	},
	{
		commandPath: ["channels", "logs"],
		exact: true,
		policy: {
			loadPlugins: "never",
			networkProxy: "bypass"
		}
	},
	{
		commandPath: ["channels", "remove"],
		exact: true,
		policy: {
			pluginRegistry: { scope: "configured-channels" },
			networkProxy: "bypass"
		}
	},
	{
		commandPath: ["channels", "resolve"],
		exact: true,
		policy: {
			pluginRegistry: { scope: "configured-channels" },
			networkProxy: "bypass"
		}
	},
	{
		commandPath: ["channels", "status"],
		exact: true,
		policy: {
			loadPlugins: "never",
			networkProxy: ({ argv }) => hasFlag(argv, "--probe") ? "default" : "bypass"
		},
		route: { id: "channels-status" }
	},
	{
		commandPath: ["channels", "list"],
		exact: true,
		policy: {
			loadPlugins: "never",
			networkProxy: "bypass"
		},
		route: { id: "channels-list" }
	},
	{
		commandPath: ["skills"],
		exact: true,
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["skills", "check"],
		exact: true,
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["skills", "info"],
		exact: true,
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["skills", "install"],
		exact: true
	},
	{
		commandPath: ["skills", "list"],
		exact: true,
		policy: { networkProxy: "bypass" }
	},
	{
		commandPath: ["skills", "search"],
		exact: true
	},
	{
		commandPath: ["skills", "update"],
		exact: true
	}
];
//#endregion
//#region src/cli/command-path-matches.ts
function matchesCommandPath(commandPath, pattern, params) {
	if (pattern.some((segment, index) => commandPath[index] !== segment)) return false;
	return !params?.exact || commandPath.length === pattern.length;
}
//#endregion
//#region src/cli/command-path-policy.ts
const DEFAULT_CLI_COMMAND_PATH_POLICY = {
	bypassConfigGuard: false,
	routeConfigGuard: "never",
	loadPlugins: "never",
	pluginRegistry: { scope: "all" },
	hideBanner: false,
	ensureCliPath: true,
	networkProxy: "default"
};
function resolveCliCommandPathPolicy(commandPath) {
	let resolvedPolicy = { ...DEFAULT_CLI_COMMAND_PATH_POLICY };
	for (const entry of cliCommandCatalog) {
		if (!entry.policy) continue;
		if (!matchesCommandPath(commandPath, entry.commandPath, { exact: entry.exact })) continue;
		Object.assign(resolvedPolicy, entry.policy);
	}
	if (isGatewayConfigBypassCommandPath(commandPath)) resolvedPolicy.bypassConfigGuard = true;
	return resolvedPolicy;
}
function isCommandPathPrefix(commandPath, pattern) {
	return pattern.every((segment, index) => commandPath[index] === segment);
}
function resolveCliCatalogCommandPath(argv) {
	const tokens = resolveGatewayCatalogCommandPath(argv) ?? getCommandPathWithRootOptions(argv, argv.length);
	if (tokens.length === 0) return [];
	let bestMatch = null;
	for (const entry of cliCommandCatalog) {
		if (!isCommandPathPrefix(tokens, entry.commandPath)) continue;
		if (!bestMatch || entry.commandPath.length > bestMatch.length) bestMatch = entry.commandPath;
	}
	return bestMatch ? [...bestMatch] : [tokens[0]];
}
function resolveCliNetworkProxyPolicy(argv) {
	const commandPath = resolveCliCatalogCommandPath(argv);
	const networkProxy = resolveCliCommandPathPolicy(commandPath).networkProxy;
	return typeof networkProxy === "function" ? networkProxy({
		argv,
		commandPath
	}) : networkProxy;
}
//#endregion
export { consumeGatewayFastPathRootOptionToken as a, cliCommandCatalog as i, resolveCliNetworkProxyPolicy as n, consumeGatewayRunOptionToken as o, matchesCommandPath as r, resolveCliCommandPathPolicy as t };
