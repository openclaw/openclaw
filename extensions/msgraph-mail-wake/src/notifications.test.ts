// Microsoft Graph Mail Wake tests cover notification parsing behavior.
import { describe, expect, it } from "vitest";
import {
  changeTypeMatchesSubscription,
  parseGraphNotificationBatch,
  parseOutlookMessageNotificationResource,
  resourceMatchesSubscription,
} from "./notifications.js";

function changeNotification(overrides?: Record<string, unknown>) {
  return {
    subscriptionId: "sub-1",
    clientState: "secret",
    changeType: "created",
    resource: "users/ops@example.com/messages/AAMk123",
    ...overrides,
  };
}

describe("parseGraphNotificationBatch", () => {
  it("parses a single change notification", () => {
    const result = parseGraphNotificationBatch({ value: [changeNotification()] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.batch.notifications).toHaveLength(1);
      expect(result.batch.notifications[0]).toEqual(changeNotification());
      expect(result.batch.lifecycleNotifications).toHaveLength(0);
    }
  });

  it("parses a mixed batch of change and lifecycle notifications", () => {
    const result = parseGraphNotificationBatch({
      value: [
        changeNotification(),
        {
          subscriptionId: "sub-1",
          clientState: "secret",
          lifecycleEvent: "subscriptionRemoved",
          resource: "users/ops@example.com/messages",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.batch.notifications).toHaveLength(1);
      expect(result.batch.lifecycleNotifications).toEqual([
        {
          subscriptionId: "sub-1",
          clientState: "secret",
          lifecycleEvent: "subscriptionRemoved",
          resource: "users/ops@example.com/messages",
        },
      ]);
    }
  });

  it("keeps clientState bytes exact (no trimming)", () => {
    const result = parseGraphNotificationBatch({
      value: [changeNotification({ clientState: "  padded-secret  " })],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.batch.notifications[0]?.clientState).toBe("  padded-secret  ");
    }
  });

  it("parses the top-level Graph notification id when present", () => {
    const result = parseGraphNotificationBatch({
      value: [changeNotification({ id: "notification-123" })],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.batch.notifications[0]?.notificationId).toBe("notification-123");
    }
  });

  it("does not let optional resourceData change the canonical notification resource", () => {
    const result = parseGraphNotificationBatch({
      value: [
        changeNotification({
          resourceData: {
            "@odata.type": "#Microsoft.Graph.Message",
            "@odata.id": "Users/abc/Messages/AAMk123",
            id: "AAMk123",
          },
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.batch.notifications[0]).toEqual(changeNotification());
    }
  });

  it.each([
    ["non-object body", null],
    ["missing value array", { something: [] }],
    ["empty value array", { value: [] }],
  ])("rejects %s envelopes", (_label, body) => {
    const result = parseGraphNotificationBatch(body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_graph_notification");
    }
  });

  it.each([
    ["non-record entry", "nope"],
    [
      "missing clientState",
      { subscriptionId: "s", changeType: "created", resource: "users/u/messages/m" },
    ],
    [
      "change entry missing changeType",
      { subscriptionId: "s", clientState: "c", resource: "users/u/messages/m" },
    ],
    [
      "change entry missing resource",
      { subscriptionId: "s", clientState: "c", changeType: "created" },
    ],
    [
      "unknown lifecycle event",
      { subscriptionId: "s", clientState: "c", lifecycleEvent: "futureEvent" },
    ],
  ])("rejects only a malformed %s in a mixed batch", (_label, invalidEntry) => {
    const result = parseGraphNotificationBatch({
      value: [invalidEntry, changeNotification()],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.batch.invalidNotifications).toBe(1);
      expect(result.batch.notifications).toEqual([changeNotification()]);
    }
  });
});

describe("parseOutlookMessageNotificationResource", () => {
  it.each([
    ["users/ops@example.com/messages/AAMk123", "AAMk123"],
    ["users/u/mailFolders('inbox')/messages/XYZ-9", "XYZ-9"],
    ["/users/u/messages/AAMk%20Encoded", "AAMk Encoded"],
  ])("parses %s", (resource, messageId) => {
    expect(parseOutlookMessageNotificationResource(resource)).toEqual({ messageId });
  });

  it.each([
    ["empty", ""],
    ["trailing slash", "users/u/messages/"],
    ["query string", "users/u/messages/m?$select=id"],
    ["double slash", "users//messages/m"],
    ["non-message resource", "users/u/calendar/events/1"],
    ["missing message id", "users/u/messages"],
    ["wrong fixed segment", "groups/u/messages/m"],
    ["bad percent encoding", "users/u/messages/%zz"],
  ])("rejects %s", (_label, resource) => {
    expect(parseOutlookMessageNotificationResource(resource)).toBeNull();
  });
});

describe("resourceMatchesSubscription", () => {
  const subscriptionResource = "users/ops%40example.com/messages";

  it.each([
    ["encoded vs literal user", "users/ops@example.com/messages/AAMk1"],
    ["resolved id in user segment", "users/55efc3a4-65d4-4f97-9fbb-9d5427b0f2d6/messages/AAMk1"],
    ["different user casing", "Users/OPS@example.com/Messages/AAMk1"],
  ])("accepts %s", (_label, notificationResource) => {
    expect(resourceMatchesSubscription({ subscriptionResource, notificationResource })).toBe(true);
  });

  it("binds folder-scoped subscriptions to their folder", () => {
    const folderSubscription = "users/ops%40example.com/mailFolders('inbox')/messages";
    expect(
      resourceMatchesSubscription({
        subscriptionResource: folderSubscription,
        notificationResource: "users/ops@example.com/mailFolders('Inbox')/messages/AAMk1",
      }),
    ).toBe(true);
    expect(
      resourceMatchesSubscription({
        subscriptionResource: folderSubscription,
        notificationResource: "users/ops@example.com/mailFolders('sentitems')/messages/AAMk1",
      }),
    ).toBe(false);
    // A folder-scoped subscription must not accept the messages root, and
    // a root subscription must not accept folder resources.
    expect(
      resourceMatchesSubscription({
        subscriptionResource: folderSubscription,
        notificationResource: "users/ops@example.com/messages/AAMk1",
      }),
    ).toBe(false);
    expect(
      resourceMatchesSubscription({
        subscriptionResource,
        notificationResource: "users/ops@example.com/mailFolders('inbox')/messages/AAMk1",
      }),
    ).toBe(false);
  });

  it.each([
    ["different collection", "users/ops@example.com/events/AAMk1"],
    ["deeper path", "users/ops@example.com/messages/AAMk1/attachments/1"],
    ["different fixed segment", "groups/ops@example.com/messages/AAMk1"],
  ])("rejects %s", (_label, notificationResource) => {
    expect(resourceMatchesSubscription({ subscriptionResource, notificationResource })).toBe(false);
  });
});

describe("changeTypeMatchesSubscription", () => {
  it("matches single and multi-value subscriptions case-insensitively", () => {
    expect(
      changeTypeMatchesSubscription({ subscriptionChangeType: "created", changeType: "created" }),
    ).toBe(true);
    expect(
      changeTypeMatchesSubscription({
        subscriptionChangeType: "created,updated",
        changeType: "Updated",
      }),
    ).toBe(true);
    expect(
      changeTypeMatchesSubscription({ subscriptionChangeType: "created", changeType: "updated" }),
    ).toBe(false);
    expect(
      changeTypeMatchesSubscription({ subscriptionChangeType: "created", changeType: "deleted" }),
    ).toBe(false);
  });
});
