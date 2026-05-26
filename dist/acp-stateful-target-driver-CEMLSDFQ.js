import { n as isAcpSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { d as resolveAgentIdFromSessionKey } from "./session-key-Bte0mmcq.js";
import { n as readAcpSessionEntry } from "./session-meta-CZ8B2a4Z.js";
import { c as resolveConfiguredAcpBindingSpecFromRecord } from "./binding-registry-dyeOsusx.js";
import { c as performGatewaySessionReset } from "./session-reset-service-URLQHV3O.js";
import { n as resolveConfiguredAcpBindingSpecBySessionKey } from "./persistent-bindings.resolve-DrfbZLJ2.js";
import { n as ensureConfiguredAcpBindingSession, t as ensureConfiguredAcpBindingReady } from "./persistent-bindings.lifecycle-Bua0SWuT.js";
//#region src/channels/plugins/acp-stateful-target-driver.ts
function toAcpStatefulBindingTargetDescriptor(params) {
	const sessionKey = params.sessionKey.trim();
	if (!sessionKey) return null;
	const metaAgentId = (readAcpSessionEntry({
		...params,
		sessionKey
	})?.acp)?.agent?.trim();
	if (metaAgentId) return {
		kind: "stateful",
		driverId: "acp",
		sessionKey,
		agentId: metaAgentId
	};
	const spec = resolveConfiguredAcpBindingSpecBySessionKey({
		...params,
		sessionKey
	});
	if (!spec) {
		if (!isAcpSessionKey(sessionKey)) return null;
		return {
			kind: "stateful",
			driverId: "acp",
			sessionKey,
			agentId: resolveAgentIdFromSessionKey(sessionKey)
		};
	}
	return {
		kind: "stateful",
		driverId: "acp",
		sessionKey,
		agentId: spec.agentId,
		...spec.label ? { label: spec.label } : {}
	};
}
async function ensureAcpTargetReady(params) {
	const configuredBinding = resolveConfiguredAcpBindingSpecFromRecord(params.bindingResolution.record);
	if (!configuredBinding) return {
		ok: false,
		error: "Configured ACP binding unavailable"
	};
	return await ensureConfiguredAcpBindingReady({
		cfg: params.cfg,
		configuredBinding: {
			spec: configuredBinding,
			record: params.bindingResolution.record
		}
	});
}
async function ensureAcpTargetSession(params) {
	const spec = resolveConfiguredAcpBindingSpecFromRecord(params.bindingResolution.record);
	if (!spec) return {
		ok: false,
		sessionKey: params.bindingResolution.statefulTarget.sessionKey,
		error: "Configured ACP binding unavailable"
	};
	return await ensureConfiguredAcpBindingSession({
		cfg: params.cfg,
		spec
	});
}
async function resetAcpTargetInPlace(params) {
	const result = await performGatewaySessionReset({
		key: params.sessionKey,
		reason: params.reason,
		commandSource: params.commandSource ?? "stateful-target:acp-reset-in-place"
	});
	if (result.ok) return { ok: true };
	return {
		ok: false,
		error: result.error.message
	};
}
const acpStatefulBindingTargetDriver = {
	id: "acp",
	ensureReady: ensureAcpTargetReady,
	ensureSession: ensureAcpTargetSession,
	resolveTargetBySessionKey: toAcpStatefulBindingTargetDescriptor,
	resetInPlace: resetAcpTargetInPlace
};
//#endregion
export { acpStatefulBindingTargetDriver };
