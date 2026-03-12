//#region src/utils/run-with-concurrency.ts
async function runTasksWithConcurrency(params) {
	const { tasks, limit, onTaskError } = params;
	const errorMode = params.errorMode ?? "continue";
	if (tasks.length === 0) return {
		results: [],
		firstError: void 0,
		hasError: false
	};
	const resolvedLimit = Math.max(1, Math.min(limit, tasks.length));
	const results = Array.from({ length: tasks.length });
	let next = 0;
	let firstError = void 0;
	let hasError = false;
	const workers = Array.from({ length: resolvedLimit }, async () => {
		while (true) {
			if (errorMode === "stop" && hasError) return;
			const index = next;
			next += 1;
			if (index >= tasks.length) return;
			try {
				results[index] = await tasks[index]();
			} catch (error) {
				if (!hasError) {
					firstError = error;
					hasError = true;
				}
				onTaskError?.(error, index);
				if (errorMode === "stop") return;
			}
		}
	});
	await Promise.allSettled(workers);
	return {
		results,
		firstError,
		hasError
	};
}

//#endregion
export { runTasksWithConcurrency as t };