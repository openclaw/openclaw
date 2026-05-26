import { n as isAcpSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { t as resolveAgentHarnessPolicy } from "./policy-BwWh-R0D.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-P-81eBKx.js";
//#region src/agents/acp-runtime-overlay.ts
/**
* When a session key and persisted session metadata identify an ACP
* control-plane session, override the resolved runtime metadata to report the
* ACP runtime id with a "session-key" source — regardless of what the
* agent-config policy resolved to.
*
* Callers that already have model/provider context (resolveModelAgentRuntimeMetadata)
* still benefit here because the model-runtime policy chain does not inspect session
* keys for the ACP indicator.
*
* Key shape alone is not sufficient: ACP bridge sessions may use ACP-shaped
* keys without persisted SessionAcpMeta and still run the configured model.
*
* When `acpBackend` is provided and non-empty, it is used as the runtime id so that
* sessions backed by a configured non-default ACP backend (e.g. a custom registered
* backend) are reported faithfully instead of always being labelled "acpx".
* Falls back to "acpx" when no backend is known.
*/
function applyAcpRuntimeOverlay(meta, sessionKey, acpRuntime, acpBackend) {
	if (acpRuntime === true && isAcpSessionKey(sessionKey)) return {
		id: acpBackend && acpBackend.length > 0 ? acpBackend : "acpx",
		source: "session-key"
	};
	return meta;
}
//#endregion
//#region src/agents/agent-runtime-metadata.ts
function resolveModelAgentRuntimeMetadata(params) {
	const resolved = params.provider && params.model ? {
		provider: params.provider,
		model: params.model
	} : resolveDefaultModelForAgent({
		cfg: params.cfg,
		agentId: params.agentId
	});
	const policy = resolveAgentHarnessPolicy({
		provider: resolved.provider,
		modelId: resolved.model,
		config: params.cfg,
		agentId: params.agentId,
		sessionKey: params.sessionKey
	});
	return applyAcpRuntimeOverlay({
		id: policy.runtime,
		source: policy.runtimeSource ?? "implicit"
	}, params.sessionKey, params.acpRuntime, params.acpBackend);
}
//#endregion
export { resolveModelAgentRuntimeMetadata as t };
