import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import * as runtimeConfig from "openclaw/plugin-sdk/runtime-config-snapshot";
import * as bindings from "openclaw/plugin-sdk/session-binding-runtime";
import { peekSystemEventEntries } from "openclaw/plugin-sdk/system-event-runtime";
import { resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import { IMessageRpcClient, type createIMessageRpcClient } from "./client.js";
import { createChatDbMessage } from "./monitor.last-route.test-support.js";
import { monitorIMessageProvider } from "./monitor/monitor-provider.js";
import { installIMessageStateRuntimeForTest } from "./test-support/runtime.js";

const createClient = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createIMessageRpcClient: createClient,
}));
vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: vi.fn(async () => {}),
}));
afterEach(() => {
  vi.restoreAllMocks();
  resetSystemEventsForTest();
  runtimeConfig.clearRuntimeConfigSnapshot();
  bindings.testing.resetSessionBindingAdaptersForTests();
});

it("keeps a watched reaction on the runtime-bound global owner's queue", async () => {
  installIMessageStateRuntimeForTest();
  resetSystemEventsForTest();
  bindings.testing.resetSessionBindingAdaptersForTests();
  const sender = "+15550001111";
  const cfg = {
    agents: { entries: { main: {}, research: {} } },
    bindings: [{ agentId: "main", match: { channel: "imessage", accountId: "default" } }],
    channels: {
      imessage: {
        dmPolicy: "allowlist" as const,
        allowFrom: [sender],
        reactionNotifications: "all" as const,
      },
    },
  };
  runtimeConfig.setRuntimeConfigSnapshot(cfg);
  const binding = {
    bindingId: "reaction-owner",
    targetSessionKey: "global",
    targetKind: "session" as const,
    conversation: { channel: "imessage", accountId: "default", conversationId: sender },
    status: "active" as const,
    boundAt: 1,
    metadata: { agentId: "research" },
  };
  bindings.registerSessionBindingAdapter({
    ...binding.conversation,
    listBySession: () => [binding],
    resolveByConversation: () => binding,
  });
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const message = {
    ...createChatDbMessage(83, "reaction-owner-83", ""),
    chat_id: 123,
    is_reaction: true,
    reaction_emoji: "👍",
    reacted_to_guid: "bot-reply",
  };
  createClient.mockImplementation(async (options) => {
    const client = new IMessageRpcClient(options);
    vi.spyOn(client, "request").mockResolvedValue({ subscription: 1 });
    vi.spyOn(client, "waitForClose").mockImplementation(async () =>
      options?.onNotification?.({ method: "message", params: { message } }),
    );
    return client;
  });

  await monitorIMessageProvider({
    scheduler: createTestPluginServiceScheduler(),
    config: cfg,
    runtime,
  });

  expect(runtime.error).not.toHaveBeenCalled();
  expect(peekSystemEventEntries("agent:research:global")).toEqual([
    expect.objectContaining({ text: `iMessage reaction added: 👍 by ${sender} on msg bot-reply` }),
  ]);
  expect(peekSystemEventEntries("agent:main:global")).toEqual([]);
  expect(binding.targetSessionKey).toBe("global");
});
