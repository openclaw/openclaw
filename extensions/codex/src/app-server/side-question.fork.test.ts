import "./side-question.test-support.js";
import { invokeNativeHookRelay } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createAdmittedHostCapabilityTestFixture,
  createMockPluginRegistry,
  useProviderToolSchemaRuntimeForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { captureRuntimeConfigAsyncReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  recordCodexThreadForkSettings,
  recordCodexTurnForkSettings,
} from "./client-fork-settings.js";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import { codexTestTurnIds } from "./codex-app-server.test-fixtures.js";
import {
  isJsonObject,
  type CodexThreadStartParams,
  type CodexTurnStartParams,
} from "./protocol.js";

// Load the harness after its hoisted mocks have initialized the production module.
const {
  codexHookCommand,
  createFakeClient,
  extractRelayIdFromThreadConfig,
  getSharedCodexAppServerClientMock,
  readCodexAppServerBindingMock,
  runCodexAppServerSideQuestion,
  sideParams,
  toolExecuteMock,
  turnCompleted,
  useSideQuestionTestSetup,
} = await import("./side-question.test-support.js");

beforeAll(async () => {
  await captureRuntimeConfigAsyncReader()();
});

useProviderToolSchemaRuntimeForTest(["openai", "codex", "lmstudio"]);

describe("runCodexAppServerSideQuestion cache-parity fork", () => {
  useSideQuestionTestSetup();
  it.each(["live", "cached", "indexed"])(
    "denies tools with parent search=%s",
    async (webSearch) => {
      const agentEnd = vi.fn();
      const beforeFinalize = vi.fn();
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          { hookName: "agent_end", handler: agentEnd },
          { hookName: "before_agent_finalize", handler: beforeFinalize },
        ]),
      );
      const host = await createAdmittedHostCapabilityTestFixture(
        { runId: "run-side-1" },
        { toolCalls: "deny" },
      );
      const turnStarted = createDeferred<void>();
      const client = createFakeClient({
        completeTurn: false,
        onTurnStart: () => turnStarted.resolve(),
      });
      const parentThread: CodexThreadStartParams = {
        model: "gpt-5.5",
        modelProvider: "openai",
        cwd: "/tmp/parent-workspace",
        runtimeWorkspaceRoots: ["/tmp/parent-root"],
        approvalPolicy: "never",
        approvalsReviewer: "guardian_subagent",
        permissions: "parent-permissions",
        developerInstructions: "Exact parent generic policy and workspace instructions.",
        serviceTier: "priority",
        config: {
          web_search: webSearch,
          "features.code_mode": false,
          "features.computer_use": true,
          "features.custom_parent_feature": true,
        },
      };
      const parentTurn: CodexTurnStartParams = {
        threadId: "parent-thread",
        input: [],
        cwd: "/tmp/parent-workspace",
        runtimeWorkspaceRoots: ["/tmp/parent-root"],
        approvalPolicy: "never",
        approvalsReviewer: "guardian_subagent",
        sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" },
        model: "gpt-5.5",
        effort: "high",
        personality: "none",
        serviceTier: "priority",
        environments: [{ environmentId: "exact-parent-environment", cwd: "/workspace" }],
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-5.5",
            reasoning_effort: "high",
            developer_instructions: null,
          },
        },
        additionalContext: {
          parent_context: { kind: "application", value: "Unchanged parent context" },
        },
      };
      ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/agent" });
      recordCodexThreadForkSettings(client, "parent-thread", parentThread);
      recordCodexTurnForkSettings(client, parentTurn);
      const baseRequest = client.request.getMockImplementation()!;
      let relayId = "";
      client.request.mockImplementation(async (method, requestParams) => {
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/fork") {
          if (!isJsonObject(requestParams) || !isJsonObject(requestParams.config)) {
            throw new Error("Expected fork config");
          }
          const config = requestParams.config;
          expect(requestParams).toMatchObject({
            ...parentThread,
            config: { ...parentThread.config, web_search: "disabled" },
            ephemeral: true,
            excludeTurns: true,
            threadId: "parent-thread",
          });
          expect(requestParams).not.toHaveProperty("dynamicTools");
          for (const [key, value] of Object.entries(config)) {
            if (!key.startsWith("hooks.") && key !== "features.hooks" && key !== "web_search") {
              expect(parentThread.config?.[key]).toEqual(value);
            }
          }
          expect(config["hooks.Stop"]).toEqual([]);
          expect(config.web_search).toBe("disabled");
          expect(parentThread.config?.web_search).toBe(webSearch);
          relayId = extractRelayIdFromThreadConfig(config);
          const response = await invokeNativeHookRelay({
            provider: "codex",
            relayId,
            generation: codexHookCommand(config, "hooks.PreToolUse")?.command?.match(
              /--generation ([^ ]+)/,
            )?.[1],
            requireGeneration: true,
            event: "pre_tool_use",
            rawPayload: {
              hook_event_name: "PreToolUse",
              tool_name: "Bash",
              tool_use_id: "denied-native",
              tool_input: { command: "touch /tmp/never-executed" },
            },
          });
          expect(response.stdout).toContain("Tool calls are denied");
        }
        if (method === "turn/start") {
          expect(requestParams).toEqual({
            ...parentTurn,
            threadId: "side-thread",
            input: [{ type: "text", text: "What changed?", text_elements: [] }],
          });
        }
        return baseRequest(method, requestParams);
      });
      getSharedCodexAppServerClientMock.mockResolvedValue(client);
      const run = runCodexAppServerSideQuestion(
        sideParams({
          toolCalls: "deny",
          hostCapabilities: host.hostCapabilities,
          opts: { runId: "run-side-1" },
        }),
        { nativeHookRelay: { enabled: true } },
      );
      try {
        await Promise.race([
          turnStarted.promise,
          run.then(() => {
            throw new Error("Side question finished before starting its turn");
          }),
        ]);
        await expect(
          client.handleRequest({
            id: "denied-dynamic",
            method: "item/tool/call",
            params: {
              ...codexTestTurnIds("side-thread"),
              callId: "tool-1",
              tool: "wiki_status",
              arguments: {},
            },
          }),
        ).resolves.toMatchObject({ success: false });
        expect(toolExecuteMock).not.toHaveBeenCalled();
        client.emit(turnCompleted("side-thread", "turn-1", "Read-only review."));
        await expect(run).resolves.toEqual({ text: "Read-only review." });
        expect(agentEnd).not.toHaveBeenCalled();
        expect(beforeFinalize).not.toHaveBeenCalled();
        expect(client.request.mock.calls.some(([method]) => method === "thread/inject_items")).toBe(
          false,
        );
      } finally {
        client.emit(turnCompleted("side-thread", "turn-1", "Read-only review."));
        await run.catch(() => undefined);
        client.close();
        host.closeHost();
        host.closeAdmission();
      }
    },
  );

  it.each(["settled", "thread-replaced", "client-replaced"])(
    "checks physical parent ownership after admission: %s",
    async (change) => {
      const host = await createAdmittedHostCapabilityTestFixture(
        { runId: "run-side-1" },
        { toolCalls: "deny" },
      );
      const client = createFakeClient();
      ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/agent" });
      recordCodexThreadForkSettings(client, "parent-thread", { model: "gpt-5.5" });
      const baseRequest = client.request.getMockImplementation()!;
      client.request.mockImplementation(async (method, params) =>
        method === "configRequirements/read" ? { requirements: null } : baseRequest(method, params),
      );
      recordCodexTurnForkSettings(client, { threadId: "parent-thread", input: [] });
      const binding = {
        ...readCodexAppServerBindingMock(),
        clientId: client.getInstanceId(),
        updatedAt: "2026-10-01T00:00:00.000Z",
      };
      readCodexAppServerBindingMock.mockReturnValue(binding);
      getSharedCodexAppServerClientMock.mockImplementation(async () => {
        readCodexAppServerBindingMock.mockReturnValue({
          ...binding,
          updatedAt: "2026-10-01T00:00:01.000Z",
          ...(change === "thread-replaced" ? { threadId: "replacement-thread" } : {}),
          ...(change === "client-replaced" ? { clientId: "replacement-client" } : {}),
        });
        return client;
      });
      try {
        const run = runCodexAppServerSideQuestion(
          sideParams({
            toolCalls: "deny",
            hostCapabilities: host.hostCapabilities,
            opts: { runId: "run-side-1" },
          }),
          { nativeHookRelay: { enabled: true } },
        );
        if (change === "settled") {
          await expect(run).resolves.toMatchObject({ text: "Side answer." });
        } else {
          await expect(run).rejects.toThrow("Codex side-question binding changed before fork");
          expect(client.request.mock.calls.some(([method]) => method === "thread/fork")).toBe(
            false,
          );
        }
      } finally {
        client.close();
        host.closeHost();
        host.closeAdmission();
      }
    },
  );

  it.each([undefined, { enabled: false }])(
    "fails closed without native tool denial relay (%j)",
    async (nativeHookRelay) => {
      await expect(
        runCodexAppServerSideQuestion(sideParams({ toolCalls: "deny" }), { nativeHookRelay }),
      ).rejects.toThrow("tool denial requires the Codex native hook relay");
      expect(toolExecuteMock).not.toHaveBeenCalled();
    },
  );
});
