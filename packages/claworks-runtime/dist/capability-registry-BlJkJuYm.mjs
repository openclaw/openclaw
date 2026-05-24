//#region src/kernel/capability-registry.ts
var CapabilityDenied = class extends Error {
	constructor(capabilityId, tier, reason) {
		super(`Capability "${capabilityId}" denied by constitution (tier ${tier}): ${reason}`);
		this.name = "CapabilityDenied";
		this.capabilityId = capabilityId;
		this.tier = tier;
		this.constitutionReason = reason;
	}
};
var CapabilityHitlRequired = class extends Error {
	constructor(capabilityId, tier, reason) {
		super(`Capability "${capabilityId}" requires HITL (tier ${tier}): ${reason}`);
		this.name = "CapabilityHitlRequired";
		this.capabilityId = capabilityId;
		this.tier = tier;
		this.constitutionReason = reason;
	}
};
var CapabilityNotFound = class extends Error {
	constructor(capabilityId) {
		super(`Capability "${capabilityId}" not found in registry`);
		this.name = "CapabilityNotFound";
		this.capabilityId = capabilityId;
	}
};
/** 熔断器配置 */
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
const CIRCUIT_BREAKER_OPEN_DURATION_MS = 3e4;
const CIRCUIT_BREAKER_HALF_OPEN_TIMEOUT_MS = 1e4;
function createCapabilityRegistry() {
	const map = /* @__PURE__ */ new Map();
	let _constitution;
	const circuitBreakers = /* @__PURE__ */ new Map();
	function getCb(id) {
		if (!circuitBreakers.has(id)) circuitBreakers.set(id, {
			failureCount: 0,
			state: "closed",
			lastFailureAt: 0,
			openUntil: 0,
			halfOpenSince: 0
		});
		return circuitBreakers.get(id);
	}
	function recordSuccess(id) {
		const cb = circuitBreakers.get(id);
		if (!cb) return;
		cb.failureCount = 0;
		cb.state = "closed";
		cb.openUntil = 0;
		cb.halfOpenSince = 0;
	}
	function recordFailure(id) {
		const cb = getCb(id);
		cb.failureCount += 1;
		cb.lastFailureAt = Date.now();
		if (cb.state === "half-open" || cb.failureCount >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
			cb.state = "open";
			cb.openUntil = Date.now() + CIRCUIT_BREAKER_OPEN_DURATION_MS;
		}
	}
	function checkCircuitBreaker(id) {
		const cb = circuitBreakers.get(id);
		if (!cb || cb.state === "closed") return "allow";
		const now = Date.now();
		if (cb.state === "open") {
			if (now >= cb.openUntil) {
				cb.state = "half-open";
				cb.halfOpenSince = now;
				return "half-open";
			}
			return "open";
		}
		if (cb.state === "half-open") {
			if (now - cb.halfOpenSince > CIRCUIT_BREAKER_HALF_OPEN_TIMEOUT_MS) {
				cb.state = "open";
				cb.openUntil = now + CIRCUIT_BREAKER_OPEN_DURATION_MS;
				return "open";
			}
			return "half-open";
		}
		return "allow";
	}
	function register(descriptor) {
		if (!descriptor.id.trim()) throw new Error("CapabilityRegistry: id must not be empty");
		if (map.has(descriptor.id)) throw new Error(`CapabilityRegistry: capability already registered: ${descriptor.id}`);
		map.set(descriptor.id, descriptor);
	}
	return {
		register,
		registerAll(descriptors) {
			for (const d of descriptors) register(d);
		},
		unregisterPack(packId) {
			for (const [id, desc] of map.entries()) if (desc.owner.kind === "pack" && desc.owner.packId === packId) map.delete(id);
		},
		get(id) {
			return map.get(id);
		},
		list() {
			return [...map.values()].filter((d) => d.advertise !== false).map((d) => ({
				id: d.id,
				verb: d.verb,
				description: d.description,
				paramsSchema: d.paramsSchema,
				owner: d.owner
			}));
		},
		listAll() {
			return [...map.keys()];
		},
		setConstitution(constitution) {
			_constitution = constitution;
		},
		listCircuitBreakers() {
			return [...circuitBreakers.entries()].map(([id, cb]) => ({
				capabilityId: id,
				state: cb.state,
				failureCount: cb.failureCount,
				lastFailureAt: cb.lastFailureAt || void 0,
				openUntil: cb.openUntil || void 0
			}));
		},
		resetCircuitBreaker(capabilityId) {
			circuitBreakers.delete(capabilityId);
		},
		async invoke(id, ctx, params, opts = {}) {
			const descriptor = map.get(id);
			if (!descriptor) throw new CapabilityNotFound(id);
			const cbStatus = checkCircuitBreaker(id);
			if (cbStatus === "open") {
				const cb = circuitBreakers.get(id);
				throw new Error(`Capability "${id}" circuit breaker is OPEN (${cb.failureCount} failures). Retry after ${Math.ceil((cb.openUntil - Date.now()) / 1e3)}s`);
			}
			if (descriptor.rbac) {
				if (descriptor.rbac.decision === "deny") throw new CapabilityDenied(id, 1, descriptor.rbac.reason ?? "Denied by capability descriptor");
				if (descriptor.rbac.decision === "hitl_required") throw new CapabilityHitlRequired(id, 1, descriptor.rbac.reason ?? "HITL required by capability descriptor");
			}
			if (_constitution) {
				const decision = _constitution.check(id, opts.constitutionCheck);
				if (decision.action === "deny") throw new CapabilityDenied(id, decision.tier, decision.reason);
				if (decision.action === "hitl_required") throw new CapabilityHitlRequired(id, decision.tier, decision.reason);
			}
			try {
				const result = await descriptor.handler(ctx, params);
				if (cbStatus === "half-open") recordSuccess(id);
				return result;
			} catch (err) {
				recordFailure(id);
				throw err;
			}
		}
	};
}
//#endregion
export { createCapabilityRegistry as i, CapabilityHitlRequired as n, CapabilityNotFound as r, CapabilityDenied as t };
