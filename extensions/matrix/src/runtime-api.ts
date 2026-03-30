export * from "openclaw/plugin-sdk/matrix";
export {
	buildChannelConfigSchema,
	buildProbeChannelStatusSummary,
	collectStatusIssuesFromLastError,
	createActionGate,
	DEFAULT_ACCOUNT_ID,
	formatZonedTimestamp,
	getChatChannelMeta,
	jsonResult,
	normalizeAccountId,
	normalizeOptionalAccountId,
	PAIRING_APPROVED_MESSAGE,
	readNumberParam,
	readReactionParams,
	readStringArrayParam,
	readStringParam,
} from "openclaw/plugin-sdk/matrix";
export {
	dispatchReplyFromConfigWithSettledDispatcher,
	ensureConfiguredAcpBindingReady,
	maybeCreateMatrixMigrationSnapshot,
	resolveConfiguredAcpBindingRecord,
} from "openclaw/plugin-sdk/matrix-runtime-heavy";
export {
	assertHttpUrlTargetsPrivateNetwork,
	closeDispatcher,
	createPinnedDispatcher,
	type LookupFn,
	resolvePinnedHostnameWithPolicy,
	type SsrFPolicy,
	ssrfPolicyFromAllowPrivateNetwork,
} from "openclaw/plugin-sdk/ssrf-runtime";
// resolveMatrixAccountStringValues already comes from plugin-sdk/matrix.
// Re-exporting auth-precedence here makes Jiti try to define the same export twice.

export function buildTimeoutAbortSignal(params: {
	timeoutMs?: number;
	signal?: AbortSignal;
}): {
	signal?: AbortSignal;
	cleanup: () => void;
} {
	const { timeoutMs, signal } = params;
	if (!timeoutMs && !signal) {
		return { signal: undefined, cleanup: () => {} };
	}
	if (!timeoutMs) {
		return { signal, cleanup: () => {} };
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(controller.abort.bind(controller), timeoutMs);
	const onAbort = () => controller.abort();
	if (signal) {
		if (signal.aborted) {
			controller.abort();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}
