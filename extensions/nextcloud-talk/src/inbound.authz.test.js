import { describe, expect, it, vi } from "vitest";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
describe("nextcloud-talk inbound authz", () => {
  it("does not treat DM pairing-store entries as group allowlist entries", async () => {
    const readAllowFromStore = vi.fn(async () => ["attacker"]);
    const buildMentionRegexes = vi.fn(() => [/@openclaw/i]);
    setNextcloudTalkRuntime({
      channel: {
        pairing: {
          readAllowFromStore
        },
        commands: {
          shouldHandleTextCommands: () => false
        },
        text: {
          hasControlCommand: () => false
        },
        mentions: {
          buildMentionRegexes,
          matchesMentionPatterns: () => false
        }
      }
    });
    const message = {
      messageId: "m-1",
      roomToken: "room-1",
      roomName: "Room 1",
      senderId: "attacker",
      senderName: "Attacker",
      text: "hello",
      mediaType: "text/plain",
      timestamp: Date.now(),
      isGroupChat: true
    };
    const account = {
      accountId: "default",
      enabled: true,
      baseUrl: "",
      secret: "",
      secretSource: "none",
      // pragma: allowlist secret
      config: {
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "allowlist",
        groupAllowFrom: []
      }
    };
    const config = {
      channels: {
        "nextcloud-talk": {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: []
        }
      }
    };
    await handleNextcloudTalkInbound({
      message,
      account,
      config,
      runtime: {
        log: vi.fn(),
        error: vi.fn()
      }
    });
    expect(readAllowFromStore).toHaveBeenCalledWith({
      channel: "nextcloud-talk",
      accountId: "default"
    });
    expect(buildMentionRegexes).not.toHaveBeenCalled();
  });
});
