// Feishu tests cover current subagent delivery and cleanup hooks.
import {
  getRequiredHookHandler,
  registerHookHandlersForTest,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, describe, expect, it } from "vitest";
import type { ClawdbotConfig, OpenClawPluginApi } from "../runtime-api.js";
import { registerFeishuSubagentHooks } from "../subagent-hooks-api.js";
import { createFeishuThreadBindingManager as createFeishuThreadBindingManagerImpl } from "./thread-bindings.js";

const baseConfig: ClawdbotConfig = {
  session: { mainKey: "main", scope: "per-sender" },
  channels: { feishu: {} },
};

type FeishuThreadBindingManager = ReturnType<typeof createFeishuThreadBindingManagerImpl>;
let trackedManager: FeishuThreadBindingManager | null = null;

function createFeishuThreadBindingManager(): FeishuThreadBindingManager {
  trackedManager = createFeishuThreadBindingManagerImpl({ cfg: baseConfig, accountId: "work" });
  return trackedManager;
}

function registerHandlersForTest() {
  return registerHookHandlersForTest<OpenClawPluginApi>({
    config: baseConfig,
    register: registerFeishuSubagentHooks,
  });
}

function dmOrigin(sender = "ou_sender_1") {
  return {
    channel: "feishu" as const,
    accountId: "work",
    to: `user:${sender}`,
  };
}

type FeishuOrigin = {
  channel: string;
  accountId?: string;
  to?: string;
  threadId?: string;
};

function deliveryEvent(params: {
  childSessionKey: string;
  requesterOrigin?: FeishuOrigin;
  requesterSessionKey?: string;
}) {
  return {
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey ?? "agent:main:main",
    requesterOrigin: params.requesterOrigin ?? dmOrigin(),
    expectsCompletionMessage: true,
  };
}

function managedHookFixture() {
  const handlers = registerHandlersForTest();
  return {
    deliveryHandler: getRequiredHookHandler(handlers, "subagent_delivery_target"),
    endedHandler: getRequiredHookHandler(handlers, "subagent_ended"),
    manager: createFeishuThreadBindingManager(),
  };
}

describe("feishu subagent hook handlers", () => {
  afterEach(() => {
    trackedManager?.stop();
    trackedManager = null;
  });

  it("preserves the bound Feishu DM delivery target", async () => {
    const { deliveryHandler, manager } = managedHookFixture();
    manager.bindConversation({
      conversationId: "ou_sender_1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:chat-dm-child",
      metadata: { deliveryTo: "chat:oc_dm_chat_1", boundBy: "system" },
    });

    await expect(
      deliveryHandler(
        deliveryEvent({
          childSessionKey: "agent:main:subagent:chat-dm-child",
          requesterOrigin: {
            channel: "feishu",
            accountId: "work",
            to: "chat:oc_dm_chat_1",
          },
        }),
        {},
      ),
    ).resolves.toEqual({
      origin: { channel: "feishu", accountId: "work", to: "chat:oc_dm_chat_1" },
    });
  });

  it("preserves the bound Feishu topic parent context", async () => {
    const { deliveryHandler, manager } = managedHookFixture();
    manager.bindConversation({
      conversationId: "oc_group_chat:topic:om_topic_root",
      parentConversationId: "oc_group_chat",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:topic-child",
      metadata: {
        deliveryTo: "chat:oc_group_chat",
        deliveryThreadId: "om_topic_root",
        boundBy: "system",
      },
    });

    await expect(
      deliveryHandler(
        deliveryEvent({
          childSessionKey: "agent:main:subagent:topic-child",
          requesterOrigin: {
            channel: "feishu",
            accountId: "work",
            to: "chat:oc_group_chat",
            threadId: "om_topic_root",
          },
        }),
        {},
      ),
    ).resolves.toEqual({
      origin: {
        channel: "feishu",
        accountId: "work",
        to: "chat:oc_group_chat",
        threadId: "om_topic_root",
      },
    });
  });

  it("selects the requester-matching binding when a child has multiple routes", async () => {
    const { deliveryHandler, manager } = managedHookFixture();
    for (const sender of ["ou_sender_1", "ou_sender_2"]) {
      manager.bindConversation({
        conversationId: sender,
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:shared",
        metadata: { deliveryTo: `user:${sender}`, boundBy: "system" },
      });
    }

    await expect(
      deliveryHandler(
        deliveryEvent({
          childSessionKey: "agent:main:subagent:shared",
          requesterOrigin: dmOrigin("ou_sender_2"),
        }),
        {},
      ),
    ).resolves.toEqual({
      origin: { channel: "feishu", accountId: "work", to: "user:ou_sender_2" },
    });
  });

  it.each(["single", "direct", "topic"] as const)(
    "keeps the selected %s requester record private and unchanged",
    async (selection) => {
      const { deliveryHandler, manager } = managedHookFixture();
      // One account/conversation has one record, so matching requester and child routes share a session.
      const sharedSessionKey = "agent:main:subagent:shared-requester";
      const topic = selection === "topic";
      if (selection !== "single") {
        manager.bindConversation({
          conversationId: "ou_other",
          targetKind: "subagent",
          targetSessionKey: sharedSessionKey,
          metadata: { deliveryTo: "user:ou_other" },
        });
      }
      manager.bindConversation({
        conversationId: topic ? "oc_group:topic:om_topic:sender:ou_selected" : "ou_selected",
        parentConversationId: topic ? "oc_group" : undefined,
        targetKind: "subagent",
        targetSessionKey: sharedSessionKey,
        metadata: {
          deliveryTo: " chat:oc_delivery ",
          ...(topic ? { deliveryThreadId: " om_delivery " } : {}),
          label: "private route label",
          boundBy: "fixture",
          data: { internal: "not an origin field" },
        },
      });
      const records = manager.listBySessionKey(sharedSessionKey);
      const snapshot = structuredClone(records);
      expect(records).toHaveLength(selection === "single" ? 1 : 2);

      await expect(
        deliveryHandler(
          deliveryEvent({
            childSessionKey: sharedSessionKey,
            requesterSessionKey: ` ${sharedSessionKey} `,
            requesterOrigin: topic
              ? { channel: "feishu", accountId: "work", to: "chat:oc_group", threadId: "om_topic" }
              : dmOrigin(selection === "single" ? "ou_unrelated" : "ou_selected"),
          }),
          {},
        ),
      ).resolves.toStrictEqual({
        origin: {
          channel: "feishu",
          accountId: "work",
          to: "chat:oc_delivery",
          ...(topic ? { threadId: "om_delivery" } : {}),
        },
      });
      expect(manager.listBySessionKey(sharedSessionKey)).toStrictEqual(snapshot);
      for (const record of records) {
        expect(manager.getByConversationId(record.conversationId)).toBe(record);
      }
    },
  );

  it.each(["direct", "topic"] as const)(
    "does not pick one of several child routes when the requester has no %s match",
    async (selection) => {
      const { deliveryHandler, manager } = managedHookFixture();
      const sharedSessionKey = "agent:main:subagent:no-match";
      for (const sender of ["ou_one", "ou_two"]) {
        manager.bindConversation({
          conversationId: sender,
          targetKind: "subagent",
          targetSessionKey: sharedSessionKey,
        });
      }

      await expect(
        deliveryHandler(
          deliveryEvent({
            childSessionKey: sharedSessionKey,
            requesterSessionKey: sharedSessionKey,
            requesterOrigin:
              selection === "topic"
                ? {
                    channel: "feishu",
                    accountId: "work",
                    to: "chat:oc_group",
                    threadId: "om_missing",
                  }
                : dmOrigin("ou_missing"),
          }),
          {},
        ),
      ).resolves.toBeUndefined();
    },
  );

  it("keeps ambiguous requester topics unresolved unless the child has one route", async () => {
    const { deliveryHandler, manager } = managedHookFixture();
    const requesterSessionKey = "agent:main:requester";
    const childSessionKey = "agent:main:subagent:child";
    for (const sender of ["ou_a", "ou_b"]) {
      manager.bindConversation({
        conversationId: `oc_group:topic:om_topic:sender:${sender}`,
        parentConversationId: "oc_group",
        targetKind: "session",
        targetSessionKey: requesterSessionKey,
      });
    }
    for (const [chat, topic] of [
      ["oc_group", "om_topic"],
      ["oc_other", "om_other"],
    ] as const) {
      manager.bindConversation({
        conversationId: `${chat}:topic:${topic}`,
        parentConversationId: chat,
        targetKind: "subagent",
        targetSessionKey: childSessionKey,
      });
    }
    const event = deliveryEvent({
      childSessionKey,
      requesterSessionKey,
      requesterOrigin: {
        channel: "feishu",
        accountId: "work",
        to: "chat:oc_group",
        threadId: "om_topic",
      },
    });

    await expect(deliveryHandler(event, {})).resolves.toBeUndefined();

    manager.unbindConversation("oc_other:topic:om_other");
    await expect(deliveryHandler(event, {})).resolves.toEqual({
      origin: {
        channel: "feishu",
        accountId: "work",
        to: "chat:oc_group",
        threadId: "om_topic",
      },
    });
  });

  it("removes bound routes on subagent_ended", async () => {
    const { deliveryHandler, endedHandler, manager } = managedHookFixture();
    manager.bindConversation({
      conversationId: "ou_sender_1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      metadata: { deliveryTo: "user:ou_sender_1", boundBy: "system" },
    });

    await endedHandler(
      {
        targetSessionKey: "agent:main:subagent:child",
        targetKind: "subagent",
        reason: "done",
        accountId: "work",
      },
      {},
    );

    await expect(
      deliveryHandler(deliveryEvent({ childSessionKey: "agent:main:subagent:child" }), {}),
    ).resolves.toBeUndefined();
  });

  it("leaves disabled completion, unrelated channels and missing managers unchanged", async () => {
    const { deliveryHandler, manager } = managedHookFixture();
    manager.bindConversation({
      conversationId: "ou_sender_1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
    });

    await expect(
      deliveryHandler(
        {
          ...deliveryEvent({ childSessionKey: "agent:main:subagent:child" }),
          expectsCompletionMessage: false,
        },
        {},
      ),
    ).resolves.toBeUndefined();
    await expect(
      deliveryHandler(
        deliveryEvent({
          childSessionKey: "agent:main:subagent:child",
          requesterOrigin: {
            channel: "discord",
            accountId: "work",
            to: "channel:123",
          },
        }),
        {},
      ),
    ).resolves.toBeUndefined();
    manager.stop();
    await expect(
      deliveryHandler(deliveryEvent({ childSessionKey: "agent:main:subagent:child" }), {}),
    ).resolves.toBeUndefined();
  });
});
