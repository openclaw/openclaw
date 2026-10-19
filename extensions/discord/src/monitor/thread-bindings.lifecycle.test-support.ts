import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { beforeEach, vi } from "vitest";
import { isDiscordThreadChannelType } from "../channel-type.js";
import { setDiscordRuntime } from "../runtime.js";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import { resetThreadBindingsForTests } from "./thread-bindings.test-support.js";

type DiscordRuntime = Parameters<typeof setDiscordRuntime>[0];

const hoisted = vi.hoisted(() => {
  const sendMessageDiscord = vi.fn(async (_to: string, _text: string, _opts?: unknown) => ({}));
  const sendWebhookMessageDiscord = vi.fn(async (_text: string, _opts?: unknown) => ({}));
  const restGet = vi.fn(async (..._args: unknown[]) => ({
    id: "thread-1",
    type: 11,
    parent_id: "parent-1",
  }));
  const restPost = vi.fn(async (..._args: unknown[]) => ({
    id: "wh-created",
    token: "tok-created",
  }));
  const createDiscordRestClient = vi.fn((..._args: unknown[]) => ({
    rest: { get: restGet, post: restPost },
  }));
  const createThreadDiscord = vi.fn(async (..._args: unknown[]) => ({ id: "thread-created" }));
  const readAcpSessionEntryAsync = vi.fn();
  return {
    sendMessageDiscord,
    sendWebhookMessageDiscord,
    restGet,
    restPost,
    createDiscordRestClient,
    createThreadDiscord,
    readAcpSessionEntryAsync,
  };
});

vi.mock("../send.js", async () => {
  return {
    ...(await vi.importActual<typeof import("../send.js")>("../send.js")),
    addRoleDiscord: vi.fn(),
    sendMessageDiscord: hoisted.sendMessageDiscord,
    sendWebhookMessageDiscord: hoisted.sendWebhookMessageDiscord,
  };
});

vi.mock("../send.messages.js", () => ({
  createThreadDiscord: hoisted.createThreadDiscord,
}));

vi.mock("openclaw/plugin-sdk/acp-runtime", async () => {
  return {
    ...(await vi.importActual<typeof import("openclaw/plugin-sdk/acp-runtime")>(
      "openclaw/plugin-sdk/acp-runtime",
    )),
    readAcpSessionEntryAsync: hoisted.readAcpSessionEntryAsync,
  };
});

const { createThreadBindingManager } = await import("./thread-bindings.manager.js");
const discordClientModule = await import("../client.js");
const api = await import("./thread-bindings.discord-api.js");

type RestContext = { accountId: string; token?: string; cfg: OpenClawConfig };
function mockRest(params: RestContext) {
  return hoisted.createDiscordRestClient(
    { accountId: params.accountId, token: params.token },
    params.cfg,
  ).rest;
}

export function createTestThreadBindingManager(
  params: Omit<Parameters<typeof createThreadBindingManager>[0], "cfg"> & {
    cfg?: OpenClawConfig;
  } = {},
) {
  return createThreadBindingManager({
    cfg: EMPTY_DISCORD_TEST_CONFIG,
    accountId: "default",
    persist: false,
    enableSweeper: false,
    idleTimeoutMs: 24 * 60 * 60 * 1000,
    maxAgeMs: 0,
    ...params,
  });
}

export function installThreadBindingLifecycleTestHooks() {
  beforeEach(async () => {
    await resetThreadBindingsForTests();
    resetPluginStateStoreForTests();
    setDiscordRuntime({
      state: {
        openKeyedStoreV2: (options: OpenKeyedStoreOptions) =>
          createPluginStateKeyedStoreV2ForTests("discord", options, { assertCurrent() {} }),
        openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
          createPluginStateSyncKeyedStoreForTests("discord", options),
      },
    } as unknown as DiscordRuntime);
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    // mockReset restores each vi.fn(implementation), including one-shot overrides.
    for (const mock of Object.values(hoisted)) {
      mock.mockReset();
    }
    hoisted.readAcpSessionEntryAsync.mockResolvedValue(null);
    vi.spyOn(discordClientModule, "createDiscordRestClient").mockImplementation(
      (...args) =>
        hoisted.createDiscordRestClient(...args) as unknown as ReturnType<
          typeof discordClientModule.createDiscordRestClient
        >,
    );
    vi.spyOn(api, "createWebhookForChannel").mockImplementation(async (params) => {
      const created = await mockRest(params).post("mock:channel-webhook");
      return {
        webhookId: created.id.trim() || undefined,
        webhookToken: created.token.trim() || undefined,
      };
    });
    vi.spyOn(api, "resolveChannelIdForBinding").mockImplementation(async (params) => {
      const explicit = params.channelId?.trim();
      if (explicit) {
        return explicit;
      }
      const channel = await mockRest(params).get("mock:channel-resolve");
      const parentId = channel.parent_id.trim();
      return (
        (parentId && isDiscordThreadChannelType(channel.type) ? parentId : channel.id.trim()) ||
        null
      );
    });
    vi.spyOn(api, "createThreadForBinding").mockImplementation(async (params) => {
      const created = await hoisted.createThreadDiscord(
        params.channelId,
        { name: params.threadName },
        { accountId: params.accountId, token: params.token, cfg: params.cfg },
      );
      return created.id.trim() || null;
    });
    vi.spyOn(api, "maybeSendBindingMessage").mockImplementation(
      async ({ record, text, cfg, preferWebhook }) => {
        const { webhookId, webhookToken, accountId, threadId } = record;
        if (preferWebhook !== false && webhookId && webhookToken) {
          await hoisted.sendWebhookMessageDiscord(text, {
            cfg,
            webhookId,
            webhookToken,
            accountId,
            threadId,
          });
          return;
        }
        await hoisted.sendMessageDiscord(`channel:${threadId}`, text, { cfg, accountId });
      },
    );
    vi.useRealTimers();
  });
}

export { hoisted };

export function bindTestThread(
  manager: Awaited<ReturnType<typeof createThreadBindingManager>>,
  overrides: Partial<Parameters<typeof manager.bindTarget>[0]> = {},
) {
  return manager.bindTarget({
    threadId: "thread-1",
    channelId: "parent-1",
    targetKind: "subagent",
    targetSessionKey: "agent:main:subagent:child",
    agentId: "main",
    webhookId: "wh-1",
    webhookToken: "tok-1",
    ...overrides,
  });
}
