import { isSelectableCdpBrowserTarget } from "../cdp-target-filter.js";
/** A discovery deadline never cancels the shared native debugger acquisition. */
export async function awaitDiscoveryAttachment<T>(
  acquisition: Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  if (timeoutMs === undefined) {
    return acquisition;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      acquisition,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("extension relay discovery timed out: attach")),
          timeoutMs,
        ).unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function isUnavailableDiscoveryTarget(error: unknown, tabId: number): error is Error {
  return (
    error instanceof Error &&
    (error.message === "The extensions gallery cannot be scripted." ||
      error.message === "Cannot access a chrome:// URL" ||
      error.message === "Cannot access a chrome-extension:// URL of different extension" ||
      error.message === "Cannot attach to this target." ||
      error.message === `Another debugger is already attached to the tab with id: ${tabId}.` ||
      error.message === "extension relay discovery timed out: attach")
  );
}

export function discoveryTargetInfo(
  info: { title: string; url: string },
  targetId: string,
  attached: boolean,
  browserContextId: string,
): Record<string, unknown> {
  return {
    targetId,
    type: "page",
    title: info.title,
    url: info.url,
    browserContextId,
    attached,
    canAccessOpener: false,
  };
}

export function publishDiscoveryAttachment<T extends { targetId: string }>(
  announce: (attached: T) => void,
  use?: (targetId: string) => void,
): (attached: T) => void {
  return (attached) => {
    announce(attached);
    use?.(attached.targetId);
  };
}

export async function enumerateDiscoveryTargets<
  T extends { info: { url: string }; target?: { sessionId?: string } },
>(options: {
  connected: () => boolean;
  tabs: Map<number, T>;
  attach: (tabId: number, use: (targetId: string) => void) => Promise<void>;
  hasRecipients: (tabId: number) => boolean;
  targetInfo: (tab: T, targetId: string) => Record<string, unknown>;
  warn: (message: string) => void;
}): Promise<{ targetInfos: Record<string, unknown>[] } | { error: string }> {
  if (!options.connected()) {
    return { error: "Extension is disconnected" };
  }
  // Tabs can arrive while Chrome attaches the previous batch. Visit each tab
  // generation once; unavailable attachments do not hide healthy targets.
  const identities = new Map<T, string | undefined>();
  const skipped = new Map<T, { url: string; reason: string }>();
  while (options.connected()) {
    const pending = [...options.tabs].filter(
      ([, tab]) =>
        !identities.has(tab) && isSelectableCdpBrowserTarget({ type: "page", url: tab.info.url }),
    );
    if (pending.length === 0) {
      break;
    }
    for (const [, tab] of pending) {
      identities.set(tab, undefined);
    }
    await Promise.allSettled(
      pending.map(async ([tabId, tab]) => {
        const url = tab.info.url;
        try {
          await options.attach(tabId, (targetId) => {
            identities.set(tab, targetId);
          });
        } catch (error) {
          if (isUnavailableDiscoveryTarget(error, tabId)) {
            skipped.set(tab, { url, reason: error.message });
          }
        }
      }),
    );
  }
  if (!options.connected()) {
    return { error: "Extension is disconnected" };
  }
  const targetInfos: Record<string, unknown>[] = [];
  for (const [tabId, tab] of options.tabs) {
    if (!isSelectableCdpBrowserTarget({ type: "page", url: tab.info.url })) {
      continue;
    }
    const refusal = skipped.get(tab);
    if (refusal && refusal.url === tab.info.url) {
      options.warn(`Skipping tab ${tabId} during target enumeration: ${refusal.reason}`);
      continue;
    }
    const targetId = identities.get(tab);
    if (!targetId || (!tab.target?.sessionId && options.hasRecipients(tabId))) {
      return { error: "Target identities are unavailable" };
    }
    targetInfos.push(options.targetInfo(tab, targetId));
  }
  return { targetInfos };
}
