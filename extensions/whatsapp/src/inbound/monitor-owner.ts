export type WhatsAppMonitorOwnerScope = {
  accountId: string;
  isCurrent: () => boolean;
  dispose: () => void;
};

/**
 * Binds queued inbound callbacks to one Gateway account monitor lifetime.
 * Account ids can be reused after replacement, so callbacks must not outlive
 * the monitor that admitted their data.
 */
export function createWhatsAppMonitorOwnerScope(params: {
  accountId: string;
  abortSignal?: AbortSignal;
}): WhatsAppMonitorOwnerScope {
  const { accountId, abortSignal } = params;
  let disposed = false;
  return Object.freeze({
    accountId,
    isCurrent: () => !disposed && !abortSignal?.aborted,
    dispose: () => {
      disposed = true;
    },
  });
}
