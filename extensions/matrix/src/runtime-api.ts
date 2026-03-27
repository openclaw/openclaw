export {
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  buildChannelConfigSchema,
  buildProbeChannelStatusSummary,
  collectStatusIssuesFromLastError,
  createActionGate,
  formatZonedTimestamp,
  getChatChannelMeta,
  jsonResult,
  normalizeAccountId,
  normalizeOptionalAccountId,
  readNumberParam,
  readReactionParams,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/matrix";
export * from "openclaw/plugin-sdk/matrix";
export {
  assertHttpUrlTargetsPrivateNetwork,
  closeDispatcher,
  createPinnedDispatcher,
  resolvePinnedHostnameWithPolicy,
  ssrfPolicyFromAllowPrivateNetwork,
  type LookupFn,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
export {
  dispatchReplyFromConfigWithSettledDispatcher,
  ensureConfiguredAcpBindingReady,
  maybeCreateMatrixMigrationSnapshot,
  resolveConfiguredAcpBindingRecord,
} from "openclaw/plugin-sdk/matrix-runtime-heavy";
// resolveMatrixAccountStringValues already comes from plugin-sdk/matrix.
// Re-exporting auth-precedence here makes Jiti try to define the same export twice.

export function buildTimeoutAbortSignal(params: { timeoutMs?: number; signal?: AbortSignal }): {
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
