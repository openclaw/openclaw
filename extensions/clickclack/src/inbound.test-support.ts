import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { buildAgentSessionKey, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { vi } from "vitest";
import type { ClickClackDiscussionBinding } from "./discussions/binding-store.js";
import {
  asyncDiscussionTestStore,
  createDiscussionMemoryStore,
} from "./discussions/service-test-support.js";
import type {
  ClickClackMessage,
  ClickClackUser,
  CoreConfig,
  ResolvedClickClackAccount,
} from "./types.js";

const location = { baseUrl: "http://127.0.0.1:8080", workspace: "wsp_1" };

export function createInboundRuntime(includeExecution: boolean): PluginRuntime {
  const runtime = createPluginRuntimeMock();
  const sessionEntry = () => ({ sessionId: "session-id", updatedAt: 1 });
  runtime.agent.session.getSessionEntry = vi.fn(sessionEntry);
  runtime.agent.session.getSessionEntryAsync = vi.fn(async () => sessionEntry());
  runtime.channel.routing.resolveAgentRoute = vi.fn(resolveAgentRoute);
  runtime.channel.routing.buildAgentSessionKey = vi.fn(buildAgentSessionKey);
  runtime.llm.complete = vi.fn().mockResolvedValue({
    text: "service bot online",
    provider: "openai",
    model: "gpt-5.4-mini",
    agentId: "service-bot",
    usage: {},
    ...(includeExecution && {
      execution: { mode: "direct-provider", owner: { kind: "provider", id: "openai" } },
    }),
    audit: { caller: { kind: "plugin", id: "clickclack" } },
  });
  const stores = new Map<string, PluginStateSyncKeyedStore<unknown>>();
  runtime.state.openSyncKeyedStore = vi.fn((options: { namespace: string }) => {
    const store = stores.get(options.namespace) ?? createDiscussionMemoryStore<unknown>();
    stores.set(options.namespace, store);
    return store;
  }) as unknown as PluginRuntime["state"]["openSyncKeyedStore"];
  runtime.state.openKeyedStoreV2 = <T>(
    options: Parameters<PluginRuntime["state"]["openKeyedStoreV2"]>[0],
    authority?: Parameters<PluginRuntime["state"]["openKeyedStoreV2"]>[1],
  ) => asyncDiscussionTestStore<T>(runtime.state.openSyncKeyedStore, options, authority);
  return runtime;
}

export function createInboundMessage(
  overrides: Partial<ClickClackMessage> = {},
): ClickClackMessage {
  return {
    id: "msg_1",
    workspace_id: "wsp_1",
    channel_id: "chn_1",
    author_id: "usr_owner",
    thread_root_id: "msg_1",
    body: "/fast on",
    body_format: "markdown",
    created_at: "2026-05-09T12:00:00.000Z",
    author: createInboundAuthor(),
    ...overrides,
  };
}

export function createInboundDiscussionBinding(
  overrides: Partial<ClickClackDiscussionBinding> = {},
): ClickClackDiscussionBinding {
  return {
    accountId: "default",
    agentId: "research",
    sessionId: "session-id",
    serverBaseUrl: "http://127.0.0.1:8080",
    externalRef: "openclaw:test:research",
    externalUrl: "",
    workspaceRef: "wsp_1",
    workspaceId: "wsp_1",
    channelId: "chn_1",
    channelRouteId: "discussion-route",
    workspaceRouteId: "workspace-route",
    section: "Sessions",
    archived: false,
    label: "Research",
    ...overrides,
  };
}

export function createInboundDiscussionConfig(): CoreConfig {
  return {
    channels: {
      clickclack: {
        ...location,
        enabled: true,
        token: "test-token-placeholder",
        discussions: { enabled: true, workspace: "wsp_1" },
      },
    },
  };
}

export function createInboundAgentAccount(
  overrides: Partial<ResolvedClickClackAccount> = {},
): ResolvedClickClackAccount {
  const config = { ...location, allowFrom: ["*"], ...overrides.config };
  return {
    ...location,
    accountId: "default",
    enabled: true,
    configured: true,
    apiEndpoint: "http://127.0.0.1:8080",
    token: "test-token-placeholder",
    replyMode: "agent",
    toolsAllow: [],
    defaultTo: "channel:general",
    allowFrom: ["*"],
    botUserId: "usr_receiver",
    botHandle: "blackbird",
    allowBots: false,
    reconnectMs: 1_500,
    agentActivity: false,
    commandMenu: true,
    discussions: { enabled: false, workspace: "wsp_1", section: "Sessions" },
    requireMention: false,
    mentionPatterns: [],
    groups: {},
    ...overrides,
    config,
  };
}

export function createInboundAuthor(overrides: Partial<ClickClackUser> = {}): ClickClackUser {
  return {
    id: "usr_owner",
    kind: "human",
    display_name: "Peter",
    handle: "steipete",
    avatar_url: "",
    created_at: "2026-05-09T12:00:00.000Z",
    ...overrides,
  };
}

export function createInboundAccountConfig(
  account: ResolvedClickClackAccount,
  config: CoreConfig = {},
): CoreConfig {
  const {
    accountId,
    configured: _configured,
    apiEndpoint,
    tokenSource: _tokenSource,
    tokenStatus: _tokenStatus,
    credentialDiagnostics: _credentialDiagnostics,
    botHandle: _botHandle,
    config: authoredConfig,
    ...settings
  } = account;
  const accountConfig = {
    ...authoredConfig,
    ...settings,
    apiBaseUrl: apiEndpoint,
    workspace: authoredConfig.workspace ?? account.workspace,
    botUserId: authoredConfig.botUserId,
  };
  return {
    ...config,
    channels: {
      ...config.channels,
      clickclack:
        accountId === "default" ? accountConfig : { accounts: { [accountId]: accountConfig } },
    },
  };
}

export function publishInboundAccountConfig(
  runtime: PluginRuntime,
  account: ResolvedClickClackAccount,
  config: CoreConfig = {},
): void {
  vi.mocked(runtime.config.current).mockReturnValue(createInboundAccountConfig(account, config));
}
