import { ChannelType } from "discord-api-types/v10";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, expect, vi } from "vitest";
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
    rest: {
      get: restGet,
      post: restPost,
    },
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
  const actual = await vi.importActual<typeof import("../send.js")>("../send.js");
  return {
    ...actual,
    addRoleDiscord: vi.fn(),
    sendMessageDiscord: hoisted.sendMessageDiscord,
    sendWebhookMessageDiscord: hoisted.sendWebhookMessageDiscord,
  };
});

vi.mock("../send.messages.js", () => ({
  createThreadDiscord: hoisted.createThreadDiscord,
}));

const { createThreadBindingManager } = await import("./thread-bindings.manager.js");
const discordClientModule = await import("../client.js");
const discordThreadBindingApi = await import("./thread-bindings.discord-api.js");
const acpRuntime = await import("openclaw/plugin-sdk/acp-runtime");

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

export function createNonSweepingTestManager(params: {
  accountId: string;
  cfg?: OpenClawConfig;
  token?: string;
}) {
  return createTestThreadBindingManager({
    persist: false,
    enableSweeper: false,
    idleTimeoutMs: 24 * 60 * 60 * 1000,
    maxAgeMs: 0,
    ...params,
  });
}

export const requireRecord = createRequireRecord("record", "expected-label-capitalized");

export function expectFields(
  value: unknown,
  label: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expected] of Object.entries(fields)) {
    expect(record[key]).toEqual(expected);
  }
  return record;
}

export function mockCallArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls;
  if (!Array.isArray(calls)) {
    throw new Error(`Expected ${label} mock calls`);
  }
  const call = calls[callIndex];
  if (!call) {
    throw new Error(`Expected ${label} call ${callIndex + 1}`);
  }
  return call[argIndex];
}

export function installThreadBindingLifecycleTestHooks() {
  beforeEach(async () => {
    await resetThreadBindingsForTests();
    resetPluginStateStoreForTests();
    setDiscordRuntime({
      state: {
        openKeyedStore: (options: OpenKeyedStoreOptions) =>
          createPluginStateKeyedStoreForTests("discord", options),
        openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
          createPluginStateSyncKeyedStoreForTests("discord", options),
      },
    } as unknown as DiscordRuntime);
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    hoisted.sendMessageDiscord.mockReset().mockResolvedValue({});
    hoisted.sendWebhookMessageDiscord.mockReset().mockResolvedValue({});
    hoisted.restGet.mockReset().mockResolvedValue({
      id: "thread-1",
      type: 11,
      parent_id: "parent-1",
    });
    hoisted.restPost.mockReset().mockResolvedValue({
      id: "wh-created",
      token: "tok-created",
    });
    hoisted.createDiscordRestClient.mockReset().mockImplementation((..._args: unknown[]) => ({
      rest: {
        get: hoisted.restGet,
        post: hoisted.restPost,
      },
    }));
    hoisted.createThreadDiscord.mockReset().mockResolvedValue({ id: "thread-created" });
    hoisted.readAcpSessionEntryAsync.mockReset().mockReturnValue(null);
    vi.spyOn(discordClientModule, "createDiscordRestClient").mockImplementation(
      (...args) =>
        hoisted.createDiscordRestClient(...args) as unknown as ReturnType<
          typeof discordClientModule.createDiscordRestClient
        >,
    );
    vi.spyOn(discordThreadBindingApi, "createWebhookForChannel").mockImplementation(
      async (params) => {
        const rest = hoisted.createDiscordRestClient(
          {
            accountId: params.accountId,
            token: params.token,
          },
          params.cfg,
        ).rest;
        const created = (await rest.post("mock:channel-webhook")) as {
          id?: string;
          token?: string;
        };
        return {
          webhookId: typeof created?.id === "string" ? created.id.trim() || undefined : undefined,
          webhookToken:
            typeof created?.token === "string" ? created.token.trim() || undefined : undefined,
        };
      },
    );
    vi.spyOn(discordThreadBindingApi, "resolveChannelIdForBinding").mockImplementation(
      async (params) => {
        const explicit = params.channelId?.trim();
        if (explicit) {
          return explicit;
        }
        const rest = hoisted.createDiscordRestClient(
          {
            accountId: params.accountId,
            token: params.token,
          },
          params.cfg,
        ).rest;
        const channel = (await rest.get("mock:channel-resolve")) as {
          id?: string;
          type?: number;
          parent_id?: string;
          parentId?: string;
        };
        const channelId = typeof channel?.id === "string" ? channel.id.trim() : "";
        const parentId =
          typeof channel?.parent_id === "string"
            ? channel.parent_id.trim()
            : typeof channel?.parentId === "string"
              ? channel.parentId.trim()
              : "";
        const isThreadType =
          channel?.type === ChannelType.PublicThread ||
          channel?.type === ChannelType.PrivateThread ||
          channel?.type === ChannelType.AnnouncementThread;
        if (parentId && isThreadType) {
          return parentId;
        }
        return channelId || null;
      },
    );
    vi.spyOn(discordThreadBindingApi, "createThreadForBinding").mockImplementation(
      async (params) => {
        const created = await hoisted.createThreadDiscord(
          params.channelId,
          {
            name: params.threadName,
          },
          {
            accountId: params.accountId,
            token: params.token,
            cfg: params.cfg,
          },
        );
        return typeof created?.id === "string" ? created.id.trim() || null : null;
      },
    );
    vi.spyOn(discordThreadBindingApi, "maybeSendBindingMessage").mockImplementation(
      async (params) => {
        if (
          params.preferWebhook !== false &&
          params.record.webhookId &&
          params.record.webhookToken
        ) {
          await hoisted.sendWebhookMessageDiscord(params.text, {
            cfg: params.cfg,
            webhookId: params.record.webhookId,
            webhookToken: params.record.webhookToken,
            accountId: params.record.accountId,
            threadId: params.record.threadId,
          });
          return;
        }
        await hoisted.sendMessageDiscord(`channel:${params.record.threadId}`, params.text, {
          cfg: params.cfg,
          accountId: params.record.accountId,
        });
      },
    );
    vi.spyOn(acpRuntime, "readAcpSessionEntryAsync").mockImplementation(
      hoisted.readAcpSessionEntryAsync,
    );
    vi.useRealTimers();
  });
}

export const requireBinding = (
  manager: Awaited<ReturnType<typeof createThreadBindingManager>>,
  threadId: string,
) => {
  const binding = manager.getByThreadId(threadId);
  if (!binding) {
    throw new Error(`missing thread binding: ${threadId}`);
  }
  return binding;
};

export { hoisted };
