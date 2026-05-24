import { h as __exportAll } from "./claworks-i0VTM_yC.mjs";
import { randomUUID } from "node:crypto";
//#region src/planes/orch/hitl-gate.ts
var hitl_gate_exports = /* @__PURE__ */ __exportAll({ createHitlGate: () => createHitlGate });
function createHitlGate() {
	const pending = /* @__PURE__ */ new Map();
	return {
		suspend(run, stepId, message, options, timeoutSeconds, onTimeout) {
			const token = randomUUID();
			const entry = {
				token,
				runId: run.id,
				stepId,
				message,
				options,
				createdAt: /* @__PURE__ */ new Date(),
				expiresAt: timeoutSeconds ? Date.now() + timeoutSeconds * 1e3 : void 0,
				onTimeout
			};
			pending.set(token, entry);
			return token;
		},
		resolve(token, _decision, _comment) {
			const entry = pending.get(token);
			if (!entry) return null;
			pending.delete(token);
			return entry;
		},
		get(token) {
			return pending.get(token);
		},
		listPending() {
			return [...pending.values()];
		},
		expireStale() {
			const now = Date.now();
			const expired = [];
			for (const [token, entry] of pending) if (entry.expiresAt !== void 0 && now >= entry.expiresAt) {
				pending.delete(token);
				expired.push({
					pending: entry,
					decision: entry.onTimeout ?? entry.options[0] ?? "approve"
				});
			}
			return expired;
		}
	};
}
//#endregion
export { hitl_gate_exports as n, createHitlGate as t };
