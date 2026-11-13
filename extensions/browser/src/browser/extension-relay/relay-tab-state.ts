import type { RelayTabInfo } from "./relay-protocol.js";

/** Exact Chrome restrictions, never transient errors or debugger-owner conflicts. */
export function chromePageRefusal(error: unknown): string | undefined {
  if (
    error instanceof Error &&
    [
      "The extensions gallery cannot be scripted.",
      "Cannot access a chrome:// URL",
      "Cannot access a chrome-extension:// URL of different extension",
      "Cannot attach to this target.",
    ].includes(error.message)
  ) {
    return error.message;
  }
  return undefined;
}

export type RelayTabState<Client> = {
  info: RelayTabInfo;
  claimants: Set<{ client: Client }>;
  /** Target identity lasts until access/extension loss; only the session ends on detach. */
  target?: { id: string; sessionId?: string };
  attaching?: Promise<{ targetId: string; sessionId: string }>;
  retiring?: Promise<void>;
  /** Native or extension loss invalidated attachment work that auto-attach clients expect restored. */
  restoreAttachment: boolean;
  /** Latest exact Chrome refusal; observation only, never an access grant. */
  automationBlockedReason?: string;
};

export type RelayTabDescriptor = RelayTabInfo & {
  id: string;
  type: string;
  automationBlockedReason?: string;
};

/** User inventory includes refused tabs without inventing attachable CDP identities. */
export function describeRelayTabs<Client>(
  tabs: Iterable<RelayTabState<Client>>,
): RelayTabDescriptor[] {
  return [...tabs].map((tab) => {
    const descriptor: RelayTabDescriptor = {
      tabId: tab.info.tabId,
      url: tab.info.url,
      title: tab.info.title,
      active: tab.info.active,
      id: tab.target?.id ?? `tab-${tab.info.tabId}`,
      type: "page",
    };
    if (tab.automationBlockedReason) {
      descriptor.automationBlockedReason = tab.automationBlockedReason;
    }
    return descriptor;
  });
}
