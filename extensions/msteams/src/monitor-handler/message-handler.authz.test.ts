import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk/msteams";
import { describe, expect, it, vi } from "vitest";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.js";
import { setMSTeamsRuntime } from "../runtime.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";

describe("msteams monitor handler authz", () => {
  function createDeps(cfg: OpenClawConfig) {
    const readAllowFromStore = vi.fn(async () => ["attacker-aad"]);
    const upsertPairingRequest = vi.fn(async () => null);
    setMSTeamsRuntime({
      logging: { shouldLogVerbose: () => false },
      channel: {
        debounce: {
          resolveInboundDebounceMs: () => 0,
          createInboundDebouncer: <T>(params: {
            onFlush: (entries: T[]) => Promise<void>;
          }): { enqueue: (entry: T) => Promise<void> } => ({
            enqueue: async (entry: T) => {
              await params.onFlush([entry]);
            },
          }),
        },
        pairing: {
          readAllowFromStore,
          upsertPairingRequest,
        },
        text: {
          hasControlCommand: () => false,
        },
      },
    } as unknown as PluginRuntime);

    const conversationStore = {
      upsert: vi.fn(async () => undefined),
    };

    const deps: MSTeamsMessageHandlerDeps = {
      cfg,
      runtime: { error: vi.fn() } as unknown as RuntimeEnv,
      appId: "test-app",
      adapter: {} as MSTeamsMessageHandlerDeps["adapter"],
      tokenProvider: {
        getAccessToken: vi.fn(async () => "token"),
      },
      textLimit: 4000,
      mediaMaxBytes: 1024 * 1024,
      conversationStore:
        conversationStore as unknown as MSTeamsMessageHandlerDeps["conversationStore"],
      pollStore: {
        recordVote: vi.fn(async () => null),
      } as unknown as MSTeamsMessageHandlerDeps["pollStore"],
      log: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      } as unknown as MSTeamsMessageHandlerDeps["log"],
    };

    return { conversationStore, deps, readAllowFromStore, upsertPairingRequest };
  }

  it("persists first-DM conversation reference before pairing early return", async () => {
    const { conversationStore, deps, upsertPairingRequest } = createDeps({
      channels: {
        msteams: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    } as OpenClawConfig);

    const handler = createMSTeamsMessageHandler(deps);
    await handler({
      activity: {
        id: "dm-1",
        type: "message",
        text: "hello",
        from: {
          id: "blocked-id",
          aadObjectId: "blocked-aad",
          name: "Blocked User",
        },
        recipient: {
          id: "bot-id",
          name: "Bot",
        },
        conversation: {
          id: "a:dm-thread-id",
          conversationType: "personal",
        },
        channelData: {},
        attachments: [],
      },
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(upsertPairingRequest).toHaveBeenCalledWith({
      id: "blocked-aad",
      meta: { name: "Blocked User" },
    });
    expect(conversationStore.upsert).toHaveBeenCalledTimes(1);
    expect(conversationStore.upsert).toHaveBeenCalledWith(
      "a:dm-thread-id",
      expect.objectContaining({
        user: expect.objectContaining({ id: "blocked-id", aadObjectId: "blocked-aad" }),
        conversation: expect.objectContaining({
          id: "a:dm-thread-id",
          conversationType: "personal",
        }),
      }),
    );
  });

  it("does not persist DM conversation references when dmPolicy is disabled", async () => {
    const { conversationStore, deps, upsertPairingRequest } = createDeps({
      channels: {
        msteams: {
          dmPolicy: "disabled",
          allowFrom: [],
        },
      },
    } as OpenClawConfig);

    const handler = createMSTeamsMessageHandler(deps);
    await handler({
      activity: {
        id: "dm-disabled-1",
        type: "message",
        text: "hello",
        from: {
          id: "blocked-id",
          aadObjectId: "blocked-aad",
          name: "Blocked User",
        },
        recipient: {
          id: "bot-id",
          name: "Bot",
        },
        conversation: {
          id: "a:dm-disabled-thread-id",
          conversationType: "personal",
        },
        channelData: {},
        attachments: [],
      },
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(upsertPairingRequest).not.toHaveBeenCalled();
    expect(conversationStore.upsert).not.toHaveBeenCalled();
  });

  it("does not treat DM pairing-store entries as group allowlist entries", async () => {
    const { conversationStore, deps, readAllowFromStore } = createDeps({
      channels: {
        msteams: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        },
      },
    } as OpenClawConfig);

    const handler = createMSTeamsMessageHandler(deps);
    await handler({
      activity: {
        id: "msg-1",
        type: "message",
        text: "",
        from: {
          id: "attacker-id",
          aadObjectId: "attacker-aad",
          name: "Attacker",
        },
        recipient: {
          id: "bot-id",
          name: "Bot",
        },
        conversation: {
          id: "19:group@thread.tacv2",
          conversationType: "groupChat",
        },
        channelData: {},
        attachments: [],
      },
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(readAllowFromStore).toHaveBeenCalledWith({
      channel: "msteams",
      accountId: "default",
    });
    expect(conversationStore.upsert).not.toHaveBeenCalled();
  });

  it("does not widen sender auth when only a teams route allowlist is configured", async () => {
    const { conversationStore, deps } = createDeps({
      channels: {
        msteams: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
          teams: {
            team123: {
              channels: {
                "19:group@thread.tacv2": { requireMention: false },
              },
            },
          },
        },
      },
    } as OpenClawConfig);

    const handler = createMSTeamsMessageHandler(deps);
    await handler({
      activity: {
        id: "msg-1",
        type: "message",
        text: "hello",
        from: {
          id: "attacker-id",
          aadObjectId: "attacker-aad",
          name: "Attacker",
        },
        recipient: {
          id: "bot-id",
          name: "Bot",
        },
        conversation: {
          id: "19:group@thread.tacv2",
          conversationType: "groupChat",
        },
        channelData: {
          team: { id: "team123", name: "Team 123" },
          channel: { name: "General" },
        },
        attachments: [],
      },
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(conversationStore.upsert).not.toHaveBeenCalled();
  });
});
