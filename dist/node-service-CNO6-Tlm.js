import { _ as resolveNodeSystemdServiceName, c as NODE_SERVICE_MARKER, g as resolveNodeLaunchAgentLabel, l as NODE_WINDOWS_TASK_SCRIPT_NAME, s as NODE_SERVICE_KIND, v as resolveNodeWindowsTaskName } from "./paths-CBMC-f_X.js";
import { i as resolveGatewayService } from "./service-ZFeJibwt.js";
//#region src/daemon/node-service.ts
function withNodeServiceEnv(env) {
	return {
		...env,
		OPENCLAW_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
		OPENCLAW_SYSTEMD_UNIT: resolveNodeSystemdServiceName(),
		OPENCLAW_WINDOWS_TASK_NAME: resolveNodeWindowsTaskName(),
		OPENCLAW_TASK_SCRIPT_NAME: NODE_WINDOWS_TASK_SCRIPT_NAME,
		OPENCLAW_LOG_PREFIX: "node",
		OPENCLAW_SERVICE_MARKER: NODE_SERVICE_MARKER,
		OPENCLAW_SERVICE_KIND: NODE_SERVICE_KIND
	};
}
function withNodeInstallEnv(args) {
	return {
		...args,
		env: withNodeServiceEnv(args.env),
		environment: {
			...args.environment,
			OPENCLAW_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
			OPENCLAW_SYSTEMD_UNIT: resolveNodeSystemdServiceName(),
			OPENCLAW_WINDOWS_TASK_NAME: resolveNodeWindowsTaskName(),
			OPENCLAW_TASK_SCRIPT_NAME: NODE_WINDOWS_TASK_SCRIPT_NAME,
			OPENCLAW_LOG_PREFIX: "node",
			OPENCLAW_SERVICE_MARKER: NODE_SERVICE_MARKER,
			OPENCLAW_SERVICE_KIND: NODE_SERVICE_KIND
		}
	};
}
function resolveNodeService() {
	const base = resolveGatewayService();
	return {
		...base,
		stage: async (args) => {
			return base.stage(withNodeInstallEnv(args));
		},
		install: async (args) => {
			return base.install(withNodeInstallEnv(args));
		},
		uninstall: async (args) => {
			return base.uninstall({
				...args,
				env: withNodeServiceEnv(args.env)
			});
		},
		stop: async (args) => {
			return base.stop({
				...args,
				env: withNodeServiceEnv(args.env ?? {})
			});
		},
		restart: async (args) => {
			return base.restart({
				...args,
				env: withNodeServiceEnv(args.env ?? {})
			});
		},
		isLoaded: async (args) => {
			return base.isLoaded({ env: withNodeServiceEnv(args.env ?? {}) });
		},
		readCommand: (env) => base.readCommand(withNodeServiceEnv(env)),
		readRuntime: (env) => base.readRuntime(withNodeServiceEnv(env))
	};
}
//#endregion
export { resolveNodeService as t };
