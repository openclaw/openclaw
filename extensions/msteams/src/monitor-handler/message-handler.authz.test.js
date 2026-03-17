import { describe, expect, it, vi } from "vitest";
import { setMSTeamsRuntime } from "../runtime.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
describe("msteams monitor handler authz", () => {
  function createDeps(cfg) {
    const readAllowFromStore = vi.fn(async () => ["attacker-aad"]);
    setMSTeamsRuntime({
      logging: { shouldLogVerbose: () => false },
      channel: {
        debounce: {
          resolveInboundDebounceMs: () => 0,
          createInboundDebouncer: (params) => ({
            enqueue: async (entry) => {
              await params.onFlush([entry]);
            }
          })
        },
        pairing: {
          readAllowFromStore,
          upsertPairingRequest: vi.fn(async () => null)
        },
        text: {
          hasControlCommand: () => false
        }
      }
    });
    const conversationStore = {
      upsert: vi.fn(async () => void 0)
    };
    const deps = {
      cfg,
      runtime: { error: vi.fn() },
      appId: "test-app",
      adapter: {},
      tokenProvider: {
        getAccessToken: vi.fn(async () => "token")
      },
      textLimit: 4e3,
      mediaMaxBytes: 1024 * 1024,
      conversationStore,
      pollStore: {
        recordVote: vi.fn(async () => null)
      },
      log: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn()
      }
    };
    return { conversationStore, deps, readAllowFromStore };
  }
  it("does not treat DM pairing-store entries as group allowlist entries", async () => {
    const { conversationStore, deps, readAllowFromStore } = createDeps({
      channels: {
        msteams: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: []
        }
      }
    });
    const handler = createMSTeamsMessageHandler(deps);
    await handler({
      activity: {
        id: "msg-1",
        type: "message",
        text: "",
        from: {
          id: "attacker-id",
          aadObjectId: "attacker-aad",
          name: "Attacker"
        },
        recipient: {
          id: "bot-id",
          name: "Bot"
        },
        conversation: {
          id: "19:group@thread.tacv2",
          conversationType: "groupChat"
        },
        channelData: {},
        attachments: []
      },
      sendActivity: vi.fn(async () => void 0)
    });
    expect(readAllowFromStore).toHaveBeenCalledWith({
      channel: "msteams",
      accountId: "default"
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
                "19:group@thread.tacv2": { requireMention: false }
              }
            }
          }
        }
      }
    });
    const handler = createMSTeamsMessageHandler(deps);
    await handler({
      activity: {
        id: "msg-1",
        type: "message",
        text: "hello",
        from: {
          id: "attacker-id",
          aadObjectId: "attacker-aad",
          name: "Attacker"
        },
        recipient: {
          id: "bot-id",
          name: "Bot"
        },
        conversation: {
          id: "19:group@thread.tacv2",
          conversationType: "groupChat"
        },
        channelData: {
          team: { id: "team123", name: "Team 123" },
          channel: { name: "General" }
        },
        attachments: []
      },
      sendActivity: vi.fn(async () => void 0)
    });
    expect(conversationStore.upsert).not.toHaveBeenCalled();
  });
});
