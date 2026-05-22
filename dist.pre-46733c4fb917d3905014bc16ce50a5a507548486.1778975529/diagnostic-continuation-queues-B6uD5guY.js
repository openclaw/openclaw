//#region src/logging/diagnostic-continuation-queues.ts
const continuationQueueMetricsProviders = /* @__PURE__ */ new Set();
function registerDiagnosticContinuationQueueMetricsProvider(provider) {
	continuationQueueMetricsProviders.add(provider);
	return () => {
		continuationQueueMetricsProviders.delete(provider);
	};
}
function combineContinuationQueueMetrics(samples) {
	if (samples.length === 0) return;
	if (samples.length === 1) return samples[0];
	const sampledAt = Math.max(...samples.map((sample) => sample.sampledAt));
	const intervalMsValues = samples.map((sample) => sample.intervalMs).filter((value) => typeof value === "number");
	const intervalMs = intervalMsValues.length > 0 ? Math.max(...intervalMsValues) : void 0;
	const enqueuedSinceLastSample = samples.reduce((sum, sample) => sum + sample.enqueuedSinceLastSample, 0);
	const drainedSinceLastSample = samples.reduce((sum, sample) => sum + sample.drainedSinceLastSample, 0);
	const failedSinceLastSample = samples.reduce((sum, sample) => sum + sample.failedSinceLastSample, 0);
	return {
		sampledAt,
		...intervalMs !== void 0 ? { intervalMs } : {},
		totalQueued: samples.reduce((sum, sample) => sum + sample.totalQueued, 0),
		pendingQueued: samples.reduce((sum, sample) => sum + sample.pendingQueued, 0),
		pendingRunnable: samples.reduce((sum, sample) => sum + sample.pendingRunnable, 0),
		pendingScheduled: samples.reduce((sum, sample) => sum + sample.pendingScheduled, 0),
		stagedPostCompaction: samples.reduce((sum, sample) => sum + sample.stagedPostCompaction, 0),
		invalidQueued: samples.reduce((sum, sample) => sum + sample.invalidQueued, 0),
		enqueuedSinceLastSample,
		drainedSinceLastSample,
		failedSinceLastSample,
		...intervalMs !== void 0 && intervalMs > 0 ? {
			enqueueRatePerMinute: enqueuedSinceLastSample * 6e4 / intervalMs,
			drainRatePerMinute: drainedSinceLastSample * 6e4 / intervalMs,
			failedRatePerMinute: failedSinceLastSample * 6e4 / intervalMs
		} : {},
		topQueues: samples.flatMap((sample) => sample.topQueues).toSorted((a, b) => b.totalQueued - a.totalQueued || a.sessionKey.localeCompare(b.sessionKey)).slice(0, 8),
		queueDepthHistory: samples.flatMap((sample) => sample.queueDepthHistory).toSorted((a, b) => a.sampledAt - b.sampledAt).slice(-8)
	};
}
function getDiagnosticContinuationQueueMetrics(now = Date.now()) {
	const samples = [];
	for (const provider of continuationQueueMetricsProviders) {
		const sample = provider(now);
		if (sample) samples.push(sample);
	}
	return combineContinuationQueueMetrics(samples);
}
//#endregion
export { registerDiagnosticContinuationQueueMetricsProvider as n, getDiagnosticContinuationQueueMetrics as t };
