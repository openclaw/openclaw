// Microsoft Graph change-notification envelope parsing, including batched
// change and lifecycle notifications.

export type GraphChangeNotification = {
  subscriptionId: string;
  /** Top-level Graph changeNotification id (unique delivery identity). */
  notificationId?: string;
  /** Exact bytes as configured at subscription creation; never trimmed. */
  clientState: string;
  changeType: string;
  resource: string;
};

export const GRAPH_LIFECYCLE_EVENTS = [
  "missed",
  "subscriptionRemoved",
  "reauthorizationRequired",
] as const;
export type GraphLifecycleEvent = (typeof GRAPH_LIFECYCLE_EVENTS)[number];

export type GraphLifecycleNotification = {
  subscriptionId: string;
  clientState: string;
  lifecycleEvent: GraphLifecycleEvent;
  resource?: string;
};

export type GraphNotificationBatch = {
  notifications: GraphChangeNotification[];
  lifecycleNotifications: GraphLifecycleNotification[];
  invalidNotifications: number;
};

export type GraphNotificationParseResult =
  | { ok: true; batch: GraphNotificationBatch }
  | { ok: false; reason: "invalid_graph_notification" };

export type OutlookMessageNotificationResource = {
  messageId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Exact-bytes reader for shared secrets: a secret is its bytes, and trimming
 * would equate distinct values (and reject legitimately padded ones).
 */
function readExactNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isGraphLifecycleEvent(value: string): value is GraphLifecycleEvent {
  return (GRAPH_LIFECYCLE_EVENTS as readonly string[]).includes(value);
}

/**
 * Validate each Graph notification independently. Malformed entries are
 * rejected without suppressing valid siblings. If a valid sibling later fails
 * transiently, Graph retries the HTTP batch and completed siblings dedupe.
 */
export function parseGraphNotificationBatch(parsed: unknown): GraphNotificationParseResult {
  if (!isRecord(parsed) || !Array.isArray(parsed.value) || parsed.value.length === 0) {
    return { ok: false, reason: "invalid_graph_notification" };
  }

  const notifications: GraphChangeNotification[] = [];
  const lifecycleNotifications: GraphLifecycleNotification[] = [];
  let invalidNotifications = 0;
  for (const entry of parsed.value) {
    if (!isRecord(entry)) {
      invalidNotifications += 1;
      continue;
    }
    const subscriptionId = readNonEmptyString(entry.subscriptionId);
    const clientState = readExactNonEmptyString(entry.clientState);
    if (!subscriptionId || !clientState) {
      invalidNotifications += 1;
      continue;
    }

    if (entry.lifecycleEvent !== undefined) {
      const lifecycleEvent = readNonEmptyString(entry.lifecycleEvent);
      if (
        !lifecycleEvent ||
        !isGraphLifecycleEvent(lifecycleEvent) ||
        entry.changeType !== undefined
      ) {
        invalidNotifications += 1;
        continue;
      }
      lifecycleNotifications.push({
        subscriptionId,
        clientState,
        lifecycleEvent,
        ...(readNonEmptyString(entry.resource)
          ? { resource: readNonEmptyString(entry.resource) }
          : {}),
      });
      continue;
    }

    const changeType = readNonEmptyString(entry.changeType);
    const resource = readNonEmptyString(entry.resource);
    if (!changeType || !resource) {
      invalidNotifications += 1;
      continue;
    }
    const notificationId = readNonEmptyString(entry.id);
    notifications.push({
      subscriptionId,
      ...(notificationId ? { notificationId } : {}),
      clientState,
      changeType,
      resource,
    });
  }

  return {
    ok: true,
    batch: { notifications, lifecycleNotifications, invalidNotifications },
  };
}

function normalizeGraphNotificationResource(resource: string): string | null {
  const trimmed = resource.trim();
  if (!trimmed || trimmed.includes("?") || trimmed.endsWith("/")) {
    return null;
  }
  const normalized = trimmed.replace(/^\/+/, "");
  return normalized && !normalized.includes("//") ? normalized : null;
}

function matchesGraphFixedSegment(value: string, expected: string): boolean {
  return value.toLowerCase() === expected.toLowerCase();
}

function parseMessageIdSegment(value: string): OutlookMessageNotificationResource | null {
  if (!value) {
    return null;
  }
  try {
    const messageId = decodeURIComponent(value);
    return messageId.trim() ? { messageId } : null;
  } catch {
    return null;
  }
}

/**
 * Extract the message id from a Graph mail notification resource path:
 *   users/<user>/messages/<messageId>
 *   users/<user>/mailFolders('<folder>')/messages/<messageId>   (canonical)
 *   users/<user>/mailFolders/<folder>/messages/<messageId>      (tolerated)
 * Anything else is not a mailbox message resource and is rejected.
 */
export function parseOutlookMessageNotificationResource(
  resource: string,
): OutlookMessageNotificationResource | null {
  const normalized = normalizeGraphNotificationResource(resource);
  if (!normalized) {
    return null;
  }

  const segments = normalized.split("/");
  if (segments.length === 4) {
    const [usersSegment = "", userSegment = "", messagesSegment = "", messageIdSegment = ""] =
      segments;
    if (
      matchesGraphFixedSegment(usersSegment, "users") &&
      userSegment &&
      matchesGraphFixedSegment(messagesSegment, "messages")
    ) {
      return parseMessageIdSegment(messageIdSegment);
    }
    return null;
  }

  // Canonical form: users/<user>/mailFolders('<folder>')/messages/<messageId>
  if (segments.length === 5) {
    const [
      usersSegment = "",
      mailboxSegment = "",
      mailFoldersSegment = "",
      messagesSegment = "",
      messageIdSegment = "",
    ] = segments;
    if (
      matchesGraphFixedSegment(usersSegment, "users") &&
      mailboxSegment &&
      isMailFoldersSegment(mailFoldersSegment) &&
      matchesGraphFixedSegment(messagesSegment, "messages")
    ) {
      return parseMessageIdSegment(messageIdSegment);
    }
    return null;
  }

  // Tolerated unquoted form: users/<user>/mailFolders/<folder>/messages/<messageId>
  if (segments.length === 6) {
    const [
      usersSegment = "",
      mailboxSegment = "",
      mailFoldersSegment = "",
      folderSegment = "",
      messagesSegment = "",
      messageIdSegment = "",
    ] = segments;
    if (
      matchesGraphFixedSegment(usersSegment, "users") &&
      mailboxSegment &&
      matchesGraphFixedSegment(mailFoldersSegment, "mailfolders") &&
      folderSegment &&
      matchesGraphFixedSegment(messagesSegment, "messages")
    ) {
      return parseMessageIdSegment(messageIdSegment);
    }
    return null;
  }

  return null;
}

function isMailFoldersSegment(value: string): boolean {
  // mailFolders('<folder>') — folder literal content is irrelevant here; only
  // the message id is extracted.
  return /^mailfolders\('.+'\)$/i.test(value.trim());
}

function canonicalResourceSegments(resource: string): string[] | null {
  const normalized = normalizeGraphNotificationResource(resource);
  if (!normalized) {
    return null;
  }
  // Percent-decoding canonicalizes the subscribed form (users/ops%40x) against
  // the notification form (users/ops@x). Malformed escapes keep the raw form.
  let decoded = normalized;
  try {
    decoded = decodeURIComponent(normalized);
  } catch {
    // keep raw
  }
  return decoded.split("/").map((segment) => segment.toLowerCase());
}

/**
 * Bind a notification resource to the resource its subscription was created
 * for. All structural segments must match; the user segment is intentionally
 * NOT compared because Graph may echo the resolved object id where the
 * subscription used a UPN. Mailbox scope is already bound cryptographically
 * (subscriptionId + clientState); this check enforces collection scope
 * (messages root vs a specific folder) before fetch/schedule.
 */
export function resourceMatchesSubscription(params: {
  subscriptionResource: string;
  notificationResource: string;
}): boolean {
  const subscriptionSegments = canonicalResourceSegments(params.subscriptionResource);
  const notificationSegments = canonicalResourceSegments(params.notificationResource);
  if (!subscriptionSegments || !notificationSegments || notificationSegments.length < 2) {
    return false;
  }
  const container = notificationSegments.slice(0, -1);
  if (container.length !== subscriptionSegments.length) {
    return false;
  }
  for (let index = 0; index < container.length; index += 1) {
    if (index === 1) {
      continue;
    }
    if (container[index] !== subscriptionSegments[index]) {
      return false;
    }
  }
  return true;
}

/** Membership check against the (possibly multi-value) subscribed changeType. */
export function changeTypeMatchesSubscription(params: {
  subscriptionChangeType: string;
  changeType: string;
}): boolean {
  const allowed = params.subscriptionChangeType
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return allowed.includes(params.changeType.trim().toLowerCase());
}
