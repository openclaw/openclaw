import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig, NextcloudTalkInboundMessage } from "./types.js";

function installInboundAuthzRuntime(params: {
  readAllowFromStore: () => Promise<string[]>;
  buildMentionRegexes: () => RegExp[];
}) {
  setNextcloudTalkRuntime(
    createPluginRuntimeMock({
      channel: {
        pairing: {
          readAllowFromStore: params.readAllowFromStore,
        },
        commands: {
          shouldHandleTextCommands: () => false,
        },
        text: {
          hasControlCommand: () => false,
        },
        mentions: {
          buildMentionRegexes: params.buildMentionRegexes,
          matchesMentionPatterns: () => false,
        },
      },
    }),
  );
}

function createMessage(
  overrides: Partial<NextcloudTalkInboundMessage> = {},
): NextcloudTalkInboundMessage {
  return {
    messageId: "m-1",
    roomToken: "room-1",
    roomName: "Room 1",
    senderId: "attacker",
    senderName: "Attacker",
    text: "hello",
    mediaType: "text/plain",
    timestamp: Date.now(),
    isGroupChat: true,
    ...overrides,
  };
}

function createAccount(
  config: ResolvedNextcloudTalkAccount["config"] = {},
): ResolvedNextcloudTalkAccount {
  return {
    accountId: "default",
    enabled: true,
    baseUrl: "",
    secret: "",
    secretSource: "none",
    config: {
      dmPolicy: "pairing",
      allowFrom: [],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
      ...config,
    },
  };
}

describe("nextcloud-talk inbound authz", () => {
  it("does not treat DM pairing-store entries as group allowlist entries", async () => {
    const readAllowFromStore = vi.fn(async () => ["attacker"]);
    const buildMentionRegexes = vi.fn(() => [/@openclaw/i]);

    installInboundAuthzRuntime({ readAllowFromStore, buildMentionRegexes });

    const account = createAccount();
    const config: CoreConfig = { channels: { "nextcloud-talk": account.config } };

    await handleNextcloudTalkInbound({
      message: createMessage(),
      account,
      config,
      runtime: createRuntimeSpies(),
    });

    expect(readAllowFromStore).not.toHaveBeenCalled();
    expect(buildMentionRegexes).not.toHaveBeenCalled();
  });

  it("matches group rooms by token instead of colliding room names", async () => {
    const readAllowFromStore = vi.fn(async () => []);
    const buildMentionRegexes = vi.fn(() => [/@openclaw/i]);

    installInboundAuthzRuntime({ readAllowFromStore, buildMentionRegexes });

    await handleNextcloudTalkInbound({
      message: createMessage({
        messageId: "m-2",
        roomToken: "room-attacker",
        roomName: "Room Trusted",
        senderId: "trusted-user",
        senderName: "Trusted User",
      }),
      account: createAccount({
        groupAllowFrom: ["trusted-user"],
        rooms: { "room-trusted": { enabled: true } },
      }),
      config: {
        channels: {
          "nextcloud-talk": {
            groupPolicy: "allowlist",
            groupAllowFrom: ["trusted-user"],
          },
        },
      },
      runtime: createRuntimeSpies(),
    });

    expect(buildMentionRegexes).not.toHaveBeenCalled();
  });
});
