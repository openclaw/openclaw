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
import type { ClickClackMessage, CoreConfig } from "./types.js";

export function createInboundRuntime(includeExecution: boolean): PluginRuntime {
  const runtime = createPluginRuntimeMock({
    agent: {
      runEmbeddedAgent: vi.fn().mockResolvedValue({
        payloads: [{ text: "service bot online" }],
        meta: {},
      }),
      session: {
        getSessionEntry: vi.fn(() => ({ sessionId: "session-id", updatedAt: 1 })),
      },
    },
    channel: {
      routing: {
        resolveAgentRoute: vi.fn(
          (params: Parameters<PluginRuntime["channel"]["routing"]["resolveAgentRoute"]>[0]) =>
            resolveAgentRoute(params),
        ),
        buildAgentSessionKey: vi.fn(
          (params: Parameters<PluginRuntime["channel"]["routing"]["buildAgentSessionKey"]>[0]) =>
            buildAgentSessionKey(params),
        ),
      },
    },
    llm: {
      complete: vi.fn().mockResolvedValue({
        text: "service bot online",
        provider: "openai",
        model: "gpt-5.4-mini",
        agentId: "service-bot",
        usage: {},
        ...(includeExecution
          ? {
              execution: {
                mode: "direct-provider",
                owner: { kind: "provider", id: "openai" },
              },
            }
          : {}),
        audit: {
          caller: { kind: "plugin", id: "clickclack" },
        },
      }),
    },
  } as unknown as PluginRuntime);
  configureDiscussionStore(runtime);
  return runtime;
}

function configureDiscussionStore(runtime: PluginRuntime): void {
  const stores = new Map<string, PluginStateSyncKeyedStore<unknown>>();
  runtime.state.openSyncKeyedStore = vi.fn((options: { namespace: string }) => {
    const existing = stores.get(options.namespace);
    if (existing) {
      return existing;
    }
    const created = createDiscussionMemoryStore<unknown>();
    stores.set(options.namespace, created);
    return created;
  }) as unknown as PluginRuntime["state"]["openSyncKeyedStore"];
  runtime.state.openKeyedStore = <T>(
    options: Parameters<PluginRuntime["state"]["openKeyedStore"]>[0],
  ) => asyncDiscussionTestStore<T>(runtime.state.openSyncKeyedStore, options);
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
    author: {
      id: "usr_owner",
      kind: "human",
      display_name: "Peter",
      handle: "steipete",
      avatar_url: "",
      created_at: "2026-05-09T12:00:00.000Z",
    },
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
        enabled: true,
        baseUrl: "http://127.0.0.1:8080",
        token: "test-token-placeholder",
        workspace: "wsp_1",
        discussions: { enabled: true, workspace: "wsp_1" },
      },
    },
  };
}
