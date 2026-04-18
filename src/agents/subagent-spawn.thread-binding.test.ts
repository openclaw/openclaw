import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";
import { installAcceptedSubagentGatewayMock } from "./test-helpers/subagent-gateway.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  emitSessionLifecycleEventMock: vi.fn(),
  hookRunner: {
    hasHooks: vi.fn(),
    runSubagentSpawning: vi.fn(),
  },
}));

describe("spawnSubagentDirect thread binding delivery", () => {
  function loadThreadBindingSpawnModule(
    overrides: Partial<Parameters<typeof loadSubagentSpawnModuleForTest>[0]> = {},
  ) {
    return loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      loadConfig: () =>
        createSubagentSpawnTestConfig(os.tmpdir(), {
          agents: {
            defaults: {
              workspace: os.tmpdir(),
            },
            list: [{ id: "main", workspace: "/tmp/workspace-main" }],
          },
        }),
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
      emitSessionLifecycleEventMock: hoisted.emitSessionLifecycleEventMock,
      hookRunner: hoisted.hookRunner,
      resolveSubagentSpawnModelSelection: () => "openai-codex/gpt-5.4",
      resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
      ...overrides,
    });
  }

  beforeEach(() => {
    hoisted.callGatewayMock.mockReset();
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.registerSubagentRunMock.mockReset();
    hoisted.emitSessionLifecycleEventMock.mockReset();
    hoisted.hookRunner.hasHooks.mockReset();
    hoisted.hookRunner.runSubagentSpawning.mockReset();
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);
  });

  it("passes the target agent's bound account to thread binding hooks", async () => {
    const boundRoom = "!room:example.org";
    let hookRequester:
      | { channel?: string; accountId?: string; to?: string; threadId?: string | number }
      | undefined;
    hoisted.hookRunner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "subagent_spawning",
    );
    hoisted.hookRunner.runSubagentSpawning.mockImplementation(async (event: unknown) => {
      hookRequester = (
        event as {
          requester?: {
            channel?: string;
            accountId?: string;
            to?: string;
            threadId?: string | number;
          };
        }
      ).requester;
      return {
        status: "ok",
        threadBindingReady: true,
        deliveryOrigin: {
          channel: "matrix",
          to: `room:${boundRoom}`,
          threadId: "$thread-root",
        },
      };
    });
    const { spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      loadConfig: () =>
        createSubagentSpawnTestConfig(os.tmpdir(), {
          agents: {
            defaults: {
              workspace: os.tmpdir(),
              subagents: {
                allowAgents: ["bot-alpha"],
              },
            },
            list: [
              { id: "main", workspace: "/tmp/workspace-main" },
              { id: "bot-alpha", workspace: "/tmp/workspace-bot-alpha" },
            ],
          },
          bindings: [
            {
              type: "route",
              agentId: "bot-alpha",
              match: {
                channel: "matrix",
                peer: {
                  kind: "channel",
                  id: boundRoom,
                },
                accountId: "bot-alpha",
              },
            },
          ],
        }),
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
      emitSessionLifecycleEventMock: hoisted.emitSessionLifecycleEventMock,
      hookRunner: hoisted.hookRunner,
      resolveSubagentSpawnModelSelection: () => "openai-codex/gpt-5.4",
      resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
    });

    const result = await spawnSubagentDirect(
      {
        task: "reply with a marker",
        agentId: "bot-alpha",
        thread: true,
        mode: "session",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "matrix",
        agentAccountId: "bot-beta",
        agentTo: `room:${boundRoom}`,
      },
    );

    expect(result.status).toBe("accepted");
    expect(hookRequester).toMatchObject({
      channel: "matrix",
      accountId: "bot-alpha",
      to: `room:${boundRoom}`,
    });
    const agentCall = hoisted.callGatewayMock.mock.calls.find(
      ([call]) => (call as { method?: string }).method === "agent",
    )?.[0] as { params?: Record<string, unknown> } | undefined;
    expect(agentCall?.params).toMatchObject({
      channel: "matrix",
      accountId: "bot-alpha",
      to: `room:${boundRoom}`,
      threadId: "$thread-root",
      deliver: true,
    });
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterOrigin: {
          channel: "matrix",
          accountId: "bot-alpha",
          to: `room:${boundRoom}`,
          threadId: "$thread-root",
        },
        expectsCompletionMessage: false,
        spawnMode: "session",
      }),
    );
  });

  it("keeps completion announcements when only a generic binding is available", async () => {
    hoisted.hookRunner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "subagent_spawning",
    );
    hoisted.hookRunner.runSubagentSpawning.mockResolvedValue({
      status: "ok",
      threadBindingReady: true,
    });
    const { spawnSubagentDirect } = await loadThreadBindingSpawnModule({
      getSessionBindingService: () => ({
        listBySession: () => [
          {
            status: "active",
            conversation: {
              channel: "feishu",
              accountId: "work",
              conversationId: "oc_dm_chat_1",
            },
          },
        ],
      }),
      resolveConversationDeliveryTarget: () => ({
        to: "channel:oc_dm_chat_1",
      }),
    });

    const result = await spawnSubagentDirect(
      {
        task: "reply with a marker",
        thread: true,
        mode: "session",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "matrix",
        agentAccountId: "sut",
        agentTo: "room:!parent:example",
      },
    );

    expect(result.status).toBe("accepted");
    const agentCall = hoisted.callGatewayMock.mock.calls.find(
      ([call]) => (call as { method?: string }).method === "agent",
    )?.[0] as { params?: Record<string, unknown> } | undefined;
    expect(agentCall?.params).toMatchObject({
      channel: "matrix",
      accountId: "sut",
      to: "room:!parent:example",
      deliver: false,
    });
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        expectsCompletionMessage: true,
        requesterOrigin: {
          channel: "matrix",
          accountId: "sut",
          to: "room:!parent:example",
        },
      }),
    );
  });
});
