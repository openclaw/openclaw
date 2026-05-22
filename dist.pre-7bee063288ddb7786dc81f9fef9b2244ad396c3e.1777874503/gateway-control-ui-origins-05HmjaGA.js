import { n as DEFAULT_GATEWAY_PORT } from "./paths-C1_Y0cDn.js";
//#region src/config/gateway-control-ui-origins.ts
function isGatewayNonLoopbackBindMode(bind) {
	return bind === "lan" || bind === "tailnet" || bind === "custom" || bind === "auto";
}
function hasConfiguredControlUiAllowedOrigins(params) {
	if (params.dangerouslyAllowHostHeaderOriginFallback === true) return true;
	return Array.isArray(params.allowedOrigins) && params.allowedOrigins.some((origin) => typeof origin === "string" && origin.trim().length > 0);
}
function resolveGatewayPortWithDefault(port, fallback = DEFAULT_GATEWAY_PORT) {
	return typeof port === "number" && port > 0 ? port : fallback;
}
function buildDefaultControlUiAllowedOrigins(params) {
	const origins = new Set([`http://localhost:${params.port}`, `http://127.0.0.1:${params.port}`]);
	const customBindHost = params.customBindHost?.trim();
	if (params.bind === "custom" && customBindHost) origins.add(`http://${customBindHost}:${params.port}`);
	return [...origins];
}
function ensureControlUiAllowedOriginsForNonLoopbackBind(config, opts) {
	const effectiveBind = opts?.runtimeBind ?? config.gateway?.bind ?? (opts?.isContainerEnvironment?.() ? "auto" : void 0);
	if (!isGatewayNonLoopbackBindMode(effectiveBind)) return {
		config,
		seededOrigins: null,
		bind: null
	};
	if (opts?.requireControlUiEnabled && config.gateway?.controlUi?.enabled === false) return {
		config,
		seededOrigins: null,
		bind: effectiveBind
	};
	if (hasConfiguredControlUiAllowedOrigins({
		allowedOrigins: config.gateway?.controlUi?.allowedOrigins,
		dangerouslyAllowHostHeaderOriginFallback: config.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback
	})) return {
		config,
		seededOrigins: null,
		bind: effectiveBind
	};
	const seededOrigins = buildDefaultControlUiAllowedOrigins({
		port: resolveGatewayPortWithDefault(opts?.runtimePort ?? config.gateway?.port, opts?.defaultPort),
		bind: effectiveBind,
		customBindHost: config.gateway?.customBindHost
	});
	return {
		config: {
			...config,
			gateway: {
				...config.gateway,
				controlUi: {
					...config.gateway?.controlUi,
					allowedOrigins: seededOrigins
				}
			}
		},
		seededOrigins,
		bind: effectiveBind
	};
}
//#endregion
export { resolveGatewayPortWithDefault as a, isGatewayNonLoopbackBindMode as i, ensureControlUiAllowedOriginsForNonLoopbackBind as n, hasConfiguredControlUiAllowedOrigins as r, buildDefaultControlUiAllowedOrigins as t };
