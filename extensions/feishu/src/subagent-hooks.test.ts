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

let trackedManager: ReturnType<typeof createFeishuThreadBindingManagerImpl> | null = null;

function origin(to: string, threadId?: string) {
  return { channel: "feishu" as const, accountId: "work", to, ...(threadId ? { threadId } : {}) };
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
    requesterOrigin: params.requesterOrigin ?? origin("user:ou_sender_1"),
    expectsCompletionMessage: true,
  };
}

function managedHookFixture() {
  const handlers = registerHookHandlersForTest<OpenClawPluginApi>({
    config: baseConfig,
    register: registerFeishuSubagentHooks,
  });
  const manager = createFeishuThreadBindingManagerImpl({ cfg: baseConfig, accountId: "work" });
  trackedManager = manager;
  const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
  return {
    deliveryHandler,
    deliver: (
      childSessionKey: string,
      requesterOrigin?: FeishuOrigin,
      requesterSessionKey?: string,
    ) =>
      deliveryHandler(deliveryEvent({ childSessionKey, requesterOrigin, requesterSessionKey }), {}),
    endedHandler: getRequiredHookHandler(handlers, "subagent_ended"),
    manager,
    bind: (
      params: Omit<Parameters<typeof manager.bindConversation>[0], "targetKind"> & {
        targetKind?: "subagent" | "session";
      },
    ) => manager.bindConversation({ targetKind: "subagent", ...params }),
  };
}

describe("feishu subagent hook handlers", () => {
  afterEach(() => {
    trackedManager?.stop();
    trackedManager = null;
  });

  it("preserves the bound Feishu DM delivery target", async () => {
    const { deliver, bind } = managedHookFixture();
    bind({
      conversationId: "ou_sender_1",
      targetSessionKey: "agent:main:subagent:chat-dm-child",
      metadata: { deliveryTo: "chat:oc_dm_chat_1", boundBy: "system" },
    });

    await expect(
      deliver("agent:main:subagent:chat-dm-child", origin("chat:oc_dm_chat_1")),
    ).resolves.toEqual({ origin: origin("chat:oc_dm_chat_1") });
  });

  it("preserves the bound Feishu topic parent context", async () => {
    const { deliver, bind } = managedHookFixture();
    bind({
      conversationId: "oc_group_chat:topic:om_topic_root",
      parentConversationId: "oc_group_chat",
      targetSessionKey: "agent:main:subagent:topic-child",
      metadata: {
        deliveryTo: "chat:oc_group_chat",
        deliveryThreadId: "om_topic_root",
        boundBy: "system",
      },
    });

    await expect(
      deliver("agent:main:subagent:topic-child", origin("chat:oc_group_chat", "om_topic_root")),
    ).resolves.toEqual({ origin: origin("chat:oc_group_chat", "om_topic_root") });
  });

  it("selects the requester-matching binding when a child has multiple routes", async () => {
    const { deliver, bind } = managedHookFixture();
    for (const sender of ["ou_sender_1", "ou_sender_2"]) {
      bind({
        conversationId: sender,
        targetSessionKey: "agent:main:subagent:shared",
        metadata: { deliveryTo: `user:${sender}`, boundBy: "system" },
      });
    }

    await expect(
      deliver("agent:main:subagent:shared", origin("user:ou_sender_2")),
    ).resolves.toEqual({
      origin: origin("user:ou_sender_2"),
    });
  });

  it.each(["single", "direct", "topic"] as const)(
    "keeps the selected %s requester record private and unchanged",
    async (selection) => {
      const { deliver, bind, manager } = managedHookFixture();
      // One account/conversation has one record, so matching requester and child routes share a session.
      const sharedSessionKey = "agent:main:subagent:shared-requester";
      const topic = selection === "topic";
      if (selection !== "single") {
        bind({
          conversationId: "ou_other",
          targetSessionKey: sharedSessionKey,
          metadata: { deliveryTo: "user:ou_other" },
        });
      }
      bind({
        conversationId: topic ? "oc_group:topic:om_topic:sender:ou_selected" : "ou_selected",
        parentConversationId: topic ? "oc_group" : undefined,
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
        deliver(
          sharedSessionKey,
          topic
            ? origin("chat:oc_group", "om_topic")
            : origin(selection === "single" ? "user:ou_unrelated" : "user:ou_selected"),
          ` ${sharedSessionKey} `,
        ),
      ).resolves.toStrictEqual({
        origin: origin("chat:oc_delivery", topic ? "om_delivery" : undefined),
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
      const { deliver, bind } = managedHookFixture();
      const sharedSessionKey = "agent:main:subagent:no-match";
      for (const sender of ["ou_one", "ou_two"]) {
        bind({
          conversationId: sender,
          targetSessionKey: sharedSessionKey,
        });
      }

      await expect(
        deliver(
          sharedSessionKey,
          selection === "topic" ? origin("chat:oc_group", "om_missing") : origin("user:ou_missing"),
          sharedSessionKey,
        ),
      ).resolves.toBeUndefined();
    },
  );

  it("keeps ambiguous requester topics unresolved unless the child has one route", async () => {
    const { deliveryHandler, bind, manager } = managedHookFixture();
    const requesterSessionKey = "agent:main:requester";
    const childSessionKey = "agent:main:subagent:child";
    for (const sender of ["ou_a", "ou_b"]) {
      bind({
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
      bind({
        conversationId: `${chat}:topic:${topic}`,
        parentConversationId: chat,
        targetSessionKey: childSessionKey,
      });
    }
    const event = deliveryEvent({
      childSessionKey,
      requesterSessionKey,
      requesterOrigin: origin("chat:oc_group", "om_topic"),
    });

    await expect(deliveryHandler(event, {})).resolves.toBeUndefined();

    manager.unbindConversation("oc_other:topic:om_other");
    await expect(deliveryHandler(event, {})).resolves.toEqual({
      origin: origin("chat:oc_group", "om_topic"),
    });
  });

  it("removes bound routes on subagent_ended", async () => {
    const { deliver, endedHandler, bind } = managedHookFixture();
    bind({
      conversationId: "ou_sender_1",
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

    await expect(deliver("agent:main:subagent:child")).resolves.toBeUndefined();
  });

  it("leaves disabled completion, unrelated channels and missing managers unchanged", async () => {
    const { deliveryHandler, manager } = managedHookFixture();
    manager.bindConversation({
      conversationId: "ou_sender_1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
    });
    const event = deliveryEvent({ childSessionKey: "agent:main:subagent:child" });

    await expect(
      deliveryHandler({ ...event, expectsCompletionMessage: false }, {}),
    ).resolves.toBeUndefined();
    await expect(
      deliveryHandler(
        { ...event, requesterOrigin: { channel: "discord", accountId: "work", to: "channel:123" } },
        {},
      ),
    ).resolves.toBeUndefined();
    manager.stop();
    await expect(deliveryHandler(event, {})).resolves.toBeUndefined();
  });
});
