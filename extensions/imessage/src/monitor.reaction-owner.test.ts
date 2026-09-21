import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/session-binding-runtime";
import {
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "openclaw/plugin-sdk/system-event-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IMessageRpcClient, type createIMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";
import { installIMessageStateRuntimeForTest } from "./test-support/runtime.js";

const createClient = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createIMessageRpcClient: createClient,
}));
vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: vi.fn(async () => {}),
}));
vi.mock("./probe.js", () => ({
  probeIMessagePrivateApi: vi.fn(async () => ({
    available: false,
    v2Ready: false,
    selectors: {},
    rpcMethods: [],
  })),
}));

beforeEach(() => {
  installIMessageStateRuntimeForTest();
  resetSystemEventsForTest();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetSystemEventsForTest();
  clearRuntimeConfigSnapshot();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
});

it("keeps a watched reaction on the runtime-bound global owner's queue", async () => {
  const sender = "+15550001111";
  const cfg = {
    agents: { list: [{ id: "main", default: true }, { id: "research" }] },
    channels: {
      imessage: {
        dmPolicy: "allowlist" as const,
        allowFrom: [sender],
        reactionNotifications: "all" as const,
      },
    },
    messages: { inbound: { debounceMs: 0 } },
  };
  setRuntimeConfigSnapshot(cfg);
  const binding = {
    bindingId: "reaction-owner",
    targetSessionKey: "global",
    targetKind: "session" as const,
    conversation: { channel: "imessage", accountId: "default", conversationId: sender },
    status: "active" as const,
    boundAt: 1,
    metadata: { agentId: "research" },
  };
  registerSessionBindingAdapter({
    ...binding.conversation,
    listBySession: () => [binding],
    resolveByConversation: () => binding,
  });
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  createClient.mockImplementation(async (options) => {
    const client = new IMessageRpcClient(options);
    vi.spyOn(client, "request").mockResolvedValue({ subscription: 1 });
    vi.spyOn(client, "waitForClose").mockImplementation(async () => {
      options?.onNotification?.({
        method: "message",
        params: {
          message: {
            id: 83,
            guid: "reaction-owner-83",
            chat_id: 123,
            sender,
            is_from_me: false,
            is_group: false,
            text: "",
            created_at: new Date().toISOString(),
            is_reaction: true,
            reaction_emoji: "👍",
            reacted_to_guid: "bot-reply",
          },
        },
      });
      await vi.waitFor(() =>
        expect(runtime.log).toHaveBeenCalledWith(
          expect.stringContaining("reaction system event queued session=global"),
        ),
      );
    });
    return client;
  });

  await monitorIMessageProvider({ config: cfg, runtime });

  expect(peekSystemEventEntries("agent:research:global")).toEqual([
    expect.objectContaining({ text: `iMessage reaction added: 👍 by ${sender} on msg bot-reply` }),
  ]);
  expect(peekSystemEventEntries("agent:main:global")).toEqual([]);
  expect(binding.targetSessionKey).toBe("global");
  expect(runtime.error).not.toHaveBeenCalled();
});
