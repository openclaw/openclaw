//#region src/context-engine/host-compat.ts
const GENERIC_CLI_CONTEXT_ENGINE_HOST_CAPABILITIES = [
	"bootstrap",
	"after-turn",
	"maintain"
];
const PI_EMBEDDED_CONTEXT_ENGINE_HOST = {
	id: "pi-embedded",
	label: "Pi embedded runner",
	capabilities: [
		"bootstrap",
		"assemble-before-prompt",
		"after-turn",
		"maintain",
		"compact",
		"runtime-llm-complete"
	]
};
const CODEX_APP_SERVER_CONTEXT_ENGINE_HOST = {
	id: "codex-app-server",
	label: "Codex app-server harness",
	capabilities: [
		"bootstrap",
		"assemble-before-prompt",
		"after-turn",
		"maintain",
		"compact",
		"runtime-llm-complete",
		"thread-bootstrap-projection"
	]
};
/** Build the default host support advertised by the generic CLI runner. */
function buildGenericCliContextEngineHostSupport(params) {
	return {
		id: `cli:${params.backendId}`,
		label: `CLI backend "${params.backendId}"`,
		capabilities: params.capabilities ?? GENERIC_CLI_CONTEXT_ENGINE_HOST_CAPABILITIES
	};
}
/** Evaluate whether a context-engine host can safely run the requested operation. */
function evaluateContextEngineHostSupport(params) {
	const requirements = params.contextEngineInfo.hostRequirements?.[params.operation];
	if (!requirements || requirements.requiredCapabilities.length === 0) return {
		ok: true,
		requirements,
		missingCapabilities: []
	};
	const supported = new Set(params.host.capabilities);
	const missingCapabilities = requirements.requiredCapabilities.filter((capability) => !supported.has(capability));
	if (missingCapabilities.length === 0) return {
		ok: true,
		requirements,
		missingCapabilities: []
	};
	return {
		ok: false,
		requirements,
		missingCapabilities
	};
}
/** Assert that a context engine can safely run under the supplied host. */
function assertContextEngineHostSupport(params) {
	const evaluation = evaluateContextEngineHostSupport({
		contextEngineInfo: params.contextEngine.info,
		operation: params.operation,
		host: params.host
	});
	if (evaluation.ok) return;
	const engineId = params.contextEngine.info.id;
	const required = evaluation.requirements.requiredCapabilities.join(", ");
	const actual = params.host.capabilities.length > 0 ? params.host.capabilities.join(", ") : "(none)";
	const guidance = evaluation.requirements.unsupportedMessage ? ` ${evaluation.requirements.unsupportedMessage}` : "";
	throw new Error(`Context engine "${engineId}" cannot run operation "${params.operation}" on ${params.host.label}. Missing host capabilities: ${evaluation.missingCapabilities.join(", ")}. Required capabilities: ${required}. Host capabilities: ${actual}.${guidance}`);
}
//#endregion
export { evaluateContextEngineHostSupport as a, buildGenericCliContextEngineHostSupport as i, PI_EMBEDDED_CONTEXT_ENGINE_HOST as n, assertContextEngineHostSupport as r, CODEX_APP_SERVER_CONTEXT_ENGINE_HOST as t };
