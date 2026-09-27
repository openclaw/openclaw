import "./side-question.test-support.js";
import { Server } from "node:http";
import {
  invokeNativeHookRelay,
  nativeHookRelayTesting,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createAdmittedHostCapabilityTestFixture,
  createMockPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";

const {
  codexHookCommand,
  agentDelta,
  createFakeClient,
  expectNativeHookRelayReleased,
  extractRelayIdFromThreadConfig,
  getSharedCodexAppServerClientMock,
  runCodexAppServerSideQuestion,
  sideLoopRelayParams,
  threadResult,
  turnCompleted,
  turnStartResult,
  useSideQuestionTestSetup,
} = await import("./side-question.test-support.js");

describe("runCodexAppServerSideQuestion native relay readiness", () => {
  useSideQuestionTestSetup();

  it("fails closed when the direct listener cannot start", async () => {
    const listen: Server["listen"] = Reflect.get(Server.prototype, "listen");
    vi.spyOn(Server.prototype, "listen").mockImplementation(function (
      this: Server,
      ...args: Parameters<Server["listen"]>
    ) {
      const isRelayListener = this.listeners("request").some((listener) =>
        String(listener).includes("handleNativeHookRelayBridgeRequest"),
      );
      if (!isRelayListener) {
        return Reflect.apply(listen, this, args);
      }
      queueMicrotask(() => this.emit("error", new Error("fixture side listener unavailable")));
      return this;
    });
    const beforeToolCall = vi.fn(() => ({
      block: true,
      blockReason: "fixture side policy denial",
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const runId = "run-side-listener-failure";
    const host = await createAdmittedHostCapabilityTestFixture({ runId });
    const client = createFakeClient();
    let relayIdDuringFork: string | undefined;
    client.request.mockImplementation(async (method: string, requestParams: unknown) => {
      if (method === "thread/fork") {
        const config = (requestParams as { config?: Record<string, unknown> }).config;
        relayIdDuringFork = extractRelayIdFromThreadConfig(config);
        expect(
          nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayIdDuringFork),
        ).toMatchObject({
          agentId: "main",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          runId,
          channelId: "voice-room",
          allowedEvents: ["pre_tool_use", "post_tool_use", "before_agent_finalize"],
        });
        const generation = codexHookCommand(config, "hooks.PreToolUse")?.command?.match(
          /--generation ([^ ]+)/,
        )?.[1];
        const response = await invokeNativeHookRelay({
          provider: "codex",
          relayId: relayIdDuringFork,
          generation,
          requireGeneration: true,
          event: "pre_tool_use",
          rawPayload: {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_use_id: "side-listener-unavailable-tool",
            tool_input: { command: "pwd" },
          },
        });
        expect(response.stdout).toContain("fixture side policy denial");
        return threadResult("side-thread");
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          client.emit(agentDelta("side-thread", "turn-1", "Side answer."));
          client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
        });
        return turnStartResult("turn-1");
      }
      if (method === "thread/unsubscribe" || method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(
        sideLoopRelayParams({
          hostCapabilities: host.hostCapabilities,
          sessionKey: "agent:main:session-1",
          sessionEntry: {
            sessionId: "session-1",
            updatedAt: 1,
            permissionMode: "guarded",
            sessionRoot: "/tmp/workspace",
          },
          messageChannel: "discord",
          messageProvider: "discord-voice",
          currentChannelId: "discord:voice-room",
          opts: { runId },
        }),
        { nativeHookRelay: { enabled: true, hookTimeoutSec: 9 } },
      ).finally(() => {
        host.closeHost();
        host.closeAdmission();
      }),
    ).rejects.toThrow("native hook relay readiness failed (direct bridge and gateway fallback)");
    expectNativeHookRelayReleased(relayIdDuringFork);
  });
});
