//#region src/infra/backoff.ts
function computeBackoff(policy, attempt) {
	const base = policy.initialMs * policy.factor ** Math.max(attempt - 1, 0);
	const jitter = base * policy.jitter * Math.random();
	return Math.min(policy.maxMs, Math.round(base + jitter));
}
async function sleepWithAbort(ms, abortSignal) {
	if (ms <= 0) return;
	await new Promise((resolve, reject) => {
		let settled = false;
		let timer = null;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
			reject(new Error("aborted", { cause: abortSignal?.reason ?? /* @__PURE__ */ new Error("aborted") }));
		};
		if (abortSignal) {
			abortSignal.addEventListener("abort", onAbort, { once: true });
			if (abortSignal.aborted) {
				onAbort();
				return;
			}
		}
		timer = setTimeout(() => {
			settled = true;
			if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
			timer = null;
			resolve();
		}, ms);
		if (abortSignal) {
			if (abortSignal.aborted) onAbort();
		}
	});
}
//#endregion
export { sleepWithAbort as n, computeBackoff as t };
