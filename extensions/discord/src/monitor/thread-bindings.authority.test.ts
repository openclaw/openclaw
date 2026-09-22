import { ChannelType } from "discord-api-types/v10";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestClient } from "../internal/rest.js";
import * as discordRequestClient from "../proxy-request-client.js";
import { getDiscordRuntime } from "../runtime.js";
import * as discordSend from "../send.js";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import { createThreadBindingManager } from "./thread-bindings.manager.js";
import { resetThreadBindingsForTests } from "./thread-bindings.test-support.js";

const THREAD_ID = "111111111111111111";
const PARENT_ID = "222222222222222222";
const CREATED_THREAD_ID = "333333333333333333";

function createRestFixture() {
  const rest = new RequestClient("synthetic-token", {
    fetch: async () => {
      throw new Error("Unexpected Discord network request");
    },
  });
  vi.spyOn(discordRequestClient, "createDiscordRequestClient").mockReturnValue(rest);
  return {
    restGet: vi.spyOn(rest, "get").mockResolvedValue({
      id: THREAD_ID,
      type: ChannelType.PublicThread,
      parent_id: PARENT_ID,
    }),
    restPost: vi.spyOn(rest, "post").mockResolvedValue({
      id: "wh-created",
      token: "tok-created",
    }),
    sendMessageDiscord: vi
      .spyOn(discordSend, "sendMessageDiscord")
      .mockRejectedValue(new Error("Unexpected binding notice")),
    sendWebhookMessageDiscord: vi
      .spyOn(discordSend, "sendWebhookMessageDiscord")
      .mockRejectedValue(new Error("Unexpected binding notice")),
  };
}

function createTestThreadBindingManager() {
  return createThreadBindingManager({
    cfg: EMPTY_DISCORD_TEST_CONFIG,
    token: "synthetic-token",
    accountId: "default",
    persist: false,
    enableSweeper: false,
  });
}

installDiscordIngressTestRuntime();

let fixture: ReturnType<typeof createRestFixture>;

beforeEach(() => {
  resetPluginStateStoreForTests();
  resetThreadBindingsForTests();
  clearRuntimeConfigSnapshot();
  getDiscordRuntime().state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("discord", options);
  fixture = createRestFixture();
});

afterEach(() => {
  resetThreadBindingsForTests();
  resetPluginStateStoreForTests();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

describe("thread binding current authority", () => {
  it.each(["channel-lookup", "webhook-create"] as const)(
    "preserves native-create admission and settlement after owner revocation during %s",
    async (revokeAt) => {
      const manager = createTestThreadBindingManager();
      let ownerCurrent = true;
      if (revokeAt === "channel-lookup") {
        fixture.restGet.mockImplementationOnce(async () => {
          ownerCurrent = false;
          return { id: THREAD_ID, type: 11, parent_id: PARENT_ID };
        });
      } else {
        fixture.restPost.mockImplementationOnce(async () => {
          ownerCurrent = false;
          return { id: "wh-created", token: "tok-created" };
        });
      }
      try {
        const binding = getSessionBindingService().bind({
          targetSessionKey: "agent:main:session-binding",
          targetKind: "session",
          conversation: {
            channel: "discord",
            accountId: "default",
            conversationId: THREAD_ID,
          },
          placement: "current",
          assertCurrent: () => {
            if (!ownerCurrent) {
              throw new Error("Command owner was revoked");
            }
          },
        });
        if (revokeAt === "channel-lookup") {
          await expect(binding).rejects.toThrow("Command owner was revoked");
          expect(manager.getByThreadId(THREAD_ID)).toBeUndefined();
        } else {
          await expect(binding).resolves.toMatchObject({
            targetSessionKey: "agent:main:session-binding",
          });
          expect(manager.getByThreadId(THREAD_ID)).toMatchObject({
            webhookId: "wh-created",
            targetSessionKey: "agent:main:session-binding",
          });
        }
        expect(fixture.restPost).toHaveBeenCalledTimes(revokeAt === "channel-lookup" ? 0 : 1);
      } finally {
        manager.stop();
      }
    },
  );

  it("publishes an accepted child thread without admitting a new webhook or intro after revocation", async () => {
    const manager = createTestThreadBindingManager();
    let ownerCurrent = true;
    fixture.restGet.mockResolvedValueOnce({ id: PARENT_ID, type: ChannelType.GuildText });
    fixture.restPost.mockImplementationOnce(async () => {
      ownerCurrent = false;
      return { id: CREATED_THREAD_ID };
    });
    try {
      await expect(
        getSessionBindingService().bind({
          targetSessionKey: "agent:main:created-thread",
          targetKind: "session",
          conversation: {
            channel: "discord",
            accountId: "default",
            conversationId: PARENT_ID,
            parentConversationId: PARENT_ID,
          },
          placement: "child",
          metadata: { introText: "Binding ready" },
          assertCurrent: () => {
            if (!ownerCurrent) {
              throw new Error("Command owner was revoked");
            }
          },
        }),
      ).resolves.toMatchObject({ targetSessionKey: "agent:main:created-thread" });
      expect(manager.getByThreadId(CREATED_THREAD_ID)).toMatchObject({
        targetSessionKey: "agent:main:created-thread",
      });
      expect(fixture.restPost).toHaveBeenCalledOnce();
      expect(fixture.restPost.mock.calls[0]?.[0]).toBe(`/channels/${PARENT_ID}/threads`);
      expect(fixture.sendMessageDiscord).not.toHaveBeenCalled();
      expect(fixture.sendWebhookMessageDiscord).not.toHaveBeenCalled();
    } finally {
      manager.stop();
    }
  });
});
