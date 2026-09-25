// Older agent spawns could bind the requester's own chat; the sweep retires only those.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerSessionBindingAdapter,
  testing as bindingServiceTesting,
  type SessionBindingRecord,
} from "../../../infra/outbound/session-binding-service.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { startAgentSpawnTakeoverSweep } from "./subagent-takeover-bindings.js";

const FORUM = "-1001234";
const GENERAL_TOPIC = `${FORUM}:topic:1`;

function binding(params: {
  id: string;
  child: string;
  conversationId: string;
  boundBy: string;
  targetKind?: "subagent" | "session";
}): SessionBindingRecord {
  return {
    bindingId: params.id,
    targetSessionKey: params.child,
    targetKind: params.targetKind ?? "subagent",
    status: "active",
    boundAt: 0,
    conversation: {
      channel: "telegram",
      accountId: "default",
      conversationId: params.conversationId,
    },
    metadata: { boundBy: params.boundBy },
  };
}

function run(child: string): SubagentRunRecord {
  return {
    runId: `run-${child}`,
    childSessionKey: child,
    requesterSessionKey: "agent:main:telegram:group:forum",
    requesterOrigin: {
      channel: "telegram",
      accountId: "default",
      to: `telegram:${FORUM}`,
      threadId: 1,
    },
  } as SubagentRunRecord;
}

function initialBindings(): SessionBindingRecord[] {
  return [
    // Agent spawn took over the topic the owner was talking in.
    binding({
      id: "takeover",
      child: "agent:main:subagent:a",
      conversationId: GENERAL_TOPIC,
      boundBy: "system",
    }),
    // `/subagents spawn --thread` created a new topic for the user.
    binding({
      id: "user-thread",
      child: "agent:main:subagent:b",
      conversationId: `${FORUM}:topic:40`,
      boundBy: "user-1",
    }),
    // An older agent spawn that created a separate child thread is not a takeover.
    binding({
      id: "child-thread",
      child: "agent:main:subagent:c",
      conversationId: `${FORUM}:topic:41`,
      boundBy: "system",
    }),
    // A user-run `/acp spawn --bind here` owns the topic on purpose.
    binding({
      id: "acp",
      child: "agent:main:subagent:d",
      conversationId: GENERAL_TOPIC,
      boundBy: "user-1",
      targetKind: "session",
    }),
  ];
}

describe("startAgentSpawnTakeoverSweep", () => {
  let bindings: SessionBindingRecord[];

  function registerTelegramAdapter() {
    registerSessionBindingAdapter({
      channel: "telegram",
      accountId: "default",
      listBySession: (key) => bindings.filter((entry) => entry.targetSessionKey === key),
      resolveByConversation: () => null,
      unbind: async (input) => {
        const removed = bindings.filter((entry) => entry.bindingId === input.bindingId);
        bindings = bindings.filter((entry) => entry.bindingId !== input.bindingId);
        return removed;
      },
    });
  }

  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram" }),
            messaging: {
              resolveInboundConversation: ({
                to,
                threadId,
              }: {
                to?: string;
                threadId?: string;
              }) => {
                const chat = to?.replace(/^telegram:/, "") ?? "";
                return threadId
                  ? { conversationId: `${chat}:topic:${threadId}`, parentConversationId: chat }
                  : { conversationId: chat };
              },
            },
          },
        },
      ]),
    );
    bindings = initialBindings();
    registerTelegramAdapter();
  });

  afterEach(() => {
    bindingServiceTesting.resetSessionBindingAdaptersForTests();
    resetPluginRuntimeStateForTest();
  });

  const runs = () =>
    new Map(["a", "b", "c", "d"].map((id) => [id, run(`agent:main:subagent:${id}`)]));
  const warn = () => {};

  it("retires only the takeover of the requester's own conversation", async () => {
    startAgentSpawnTakeoverSweep({ runs: runs(), warn });

    await vi.waitFor(() =>
      expect(bindings.map((entry) => entry.bindingId)).toEqual([
        "user-thread",
        "child-thread",
        "acp",
      ]),
    );
  });

  it("sweeps again when a channel account's binding adapter registers", async () => {
    bindingServiceTesting.resetSessionBindingAdaptersForTests();
    bindings = initialBindings();
    startAgentSpawnTakeoverSweep({ runs: runs(), warn });
    expect(bindings).toHaveLength(4);

    registerTelegramAdapter();

    await vi.waitFor(() =>
      expect(bindings.map((entry) => entry.bindingId)).not.toContain("takeover"),
    );
  });
});
