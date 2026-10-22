import assert from "node:assert/strict";
import path from "node:path";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, onTestFinished } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  isCodexAppServerLiveThreadProtected,
  protectCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import {
  flattenCodexDynamicToolFunctions,
  isJsonObject,
  type CodexDynamicToolSpec,
} from "./protocol.js";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import {
  buildDynamicToolsForTest,
  buildDynamicDeclarationsForTest,
  createCodexToolBridgeForTest,
} from "./run-attempt-tool-catalog.test-support.js";
import {
  startOrResumeAttemptThreadWithoutSkills as startOrResumeThread,
  createAppServerOptions as createBaseAppServerOptions,
  createLeasedCodexLifecycleHarness,
} from "./thread-lifecycle.test-fixtures.js";

function createParentContinuityHarness(agentDir: string) {
  let starts = 0;
  return createLeasedCodexLifecycleHarness({
    agentDir,
    respond: async (method, input) => {
      if (method === "thread/start") {
        return threadStartResult(`parent-${++starts}`);
      }
      if (method === "thread/resume") {
        assert(isJsonObject(input) && typeof input.threadId === "string");
        return threadStartResult(input.threadId);
      }
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      throw new Error(`unexpected method: ${method}`);
    },
  });
}

function createThreadLifecycleAppServerOptions(): Parameters<
  typeof startOrResumeThread
>[0]["appServer"] {
  return {
    ...createBaseAppServerOptions(),
    connectionClass: "local-loopback",
  };
}

function createRunPaths() {
  return {
    sessionFile: path.join(tempDir, "session.jsonl"),
    workspaceDir: path.join(tempDir, "workspace"),
    agentDir: path.join(tempDir, "agent"),
  };
}

function createRunParams() {
  const { sessionFile, workspaceDir } = createRunPaths();
  return createParams(sessionFile, workspaceDir);
}

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt", () => {
  // Extends the owner/private/owner reproduction in #153354 to a child-protected parent.
  it.each([
    { privateCompletion: true, profile: "messaging", nativeToolSurfaceEnabled: true },
    { privateCompletion: true, profile: "full", nativeToolSurfaceEnabled: true },
    { privateCompletion: false, profile: "full", nativeToolSurfaceEnabled: true },
    { privateCompletion: true, profile: "full", nativeToolSurfaceEnabled: false },
  ] as const)(
    "preserves the parent across private completion=$privateCompletion with child protection profile=$profile native=$nativeToolSurfaceEnabled",
    async ({ privateCompletion, profile, nativeToolSurfaceEnabled }) => {
      const { workspaceDir, agentDir } = createRunPaths();
      const owner = createRunParams();
      owner.disableTools = false;
      owner.senderIsOwner = true;
      owner.senderId = "synthetic-owner";
      owner.messageChannel = "discord";
      owner.messageProvider = "discord";
      if (profile === "full") {
        owner.clientCaps = ["ui-commands"];
        owner.model = { ...owner.model, input: ["text", "image"] };
      }
      owner.config = {
        tools: { profile, alsoAllow: ["sessions", "gateway", "plugins"] },
        agents: { defaults: { workspace: workspaceDir } },
      };
      setCodexTestModelSupportsTools(owner, true);
      const completion = {
        ...owner,
        senderIsOwner: false,
        senderId: undefined,
        clientCaps: undefined,
        sourceReplyDeliveryMode: "automatic" as const,
        inputProvenance: {
          kind: "inter_session" as const,
          sourceSessionKey: "agent:main:subagent:child",
          sourceTool: "subagent_announce",
        },
      };
      const fixture = await createParentContinuityHarness(agentDir);
      const ids: string[] = [];
      let releaseProtection: (() => void) | undefined;
      try {
        for (const turn of [owner, privateCompletion ? completion : owner, owner]) {
          const host = await createAdmittedHostCapabilityTestFixture(turn);
          onTestFinished(() => {
            host.closeHost();
            host.closeAdmission();
          });
          turn.hostCapabilities = host.hostCapabilities;
          const tools = await buildDynamicToolsForTest(turn, workspaceDir, {
            nativeToolSurfaceEnabled,
          });
          const registered = await buildDynamicDeclarationsForTest(turn, workspaceDir, {
            ignoreDisableMessageTool: true,
            ignoreRuntimePlan: true,
            nativeToolSurfaceEnabled,
          });
          const bridge = createCodexToolBridgeForTest(turn, tools, registered);
          if (turn === completion && profile === "full") {
            // Main keeps session-stable definitions; identityless access is denied at invocation.
            expect(bridge.availableTools.some((tool) => tool.name === "transcripts")).toBe(true);
            const namespace = bridge.specs.find(
              (spec) =>
                spec.type === "namespace" && spec.tools.some((tool) => tool.name === "transcripts"),
            );
            assert(namespace?.type === "namespace");
            await expect(
              bridge.handleToolCall({
                threadId: "parent-1",
                turnId: "private-completion",
                callId: "denied-private-transcript",
                namespace: namespace.name,
                tool: "transcripts",
                arguments: { action: "status" },
              }),
            ).resolves.toMatchObject({
              success: false,
              contentItems: [
                {
                  type: "inputText",
                  text: "transcripts are unavailable in this turn: it has no user or operator identity to authorize access.",
                },
              ],
            });
          }
          // Exercise the registration/dispatch namespace boundary once. The host
          // suite owns exhaustive declaration identity and availability checks.
          if (turn === completion && !nativeToolSurfaceEnabled) {
            expect(bridge.specs).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  type: "namespace",
                  name: "openclaw_direct",
                  tools: expect.arrayContaining([
                    expect.objectContaining({ name: "openclaw" }),
                    expect.objectContaining({ name: "computer" }),
                    expect.objectContaining({ name: "exec" }),
                    expect.objectContaining({ name: "process" }),
                  ]),
                }),
                expect.objectContaining({
                  type: "namespace",
                  name: "openclaw",
                  tools: expect.arrayContaining([
                    expect.objectContaining({ name: "automations", deferLoading: true }),
                  ]),
                }),
              ]),
            );
            const direct = bridge.specs.find(
              (spec) => spec.type === "namespace" && spec.name === "openclaw_direct",
            );
            assert(direct?.type === "namespace");
            expect(direct.tools.every((tool) => tool.deferLoading !== true)).toBe(true);
            expect(direct.tools.find((tool) => tool.name === "exec")?.inputSchema).toHaveProperty(
              "properties.background",
            );
            expect(bridge.availableTools.map((tool) => tool.name)).toEqual(
              expect.arrayContaining(["exec", "process"]),
            );
            for (const [tool, args] of [
              [
                "conversations_send",
                {
                  conversationRef: "conv_00000000000000000000000000000000",
                  message: "must not run",
                },
              ],
              ["plugins", { action: "list" }],
              ["gateway", { action: "config.get" }],
              ["automations", { action: "list" }],
              ["mobile_ui", { action: "observe" }],
              ["nodes", { action: "status" }],
              ["openclaw", { message: "must not run" }],
              ["portal", { action: "list" }],
              ["terminal", { action: "list" }],
              ["computer", { action: "screenshot" }],
            ] as const) {
              expect(bridge.availableTools.map((entry) => entry.name)).toContain(tool);
              await expect(
                bridge.handleToolCall({
                  threadId: "parent-1",
                  turnId: "private-completion",
                  callId: `denied-owner-action-${tool}`,
                  namespace: ["openclaw", "computer"].includes(tool)
                    ? "openclaw_direct"
                    : "openclaw",
                  tool,
                  arguments: args,
                }),
              ).resolves.toMatchObject({
                success: true,
                transcriptDetails: { gated: true },
                contentItems: [
                  {
                    type: "inputText",
                    text: expect.stringMatching(
                      /needs the owner's authority|outside the authority this completion turn carries/,
                    ),
                  },
                ],
              });
            }
            // UI capability ceilings still remove the executable, independently of owner gates.
            expect(bridge.availableTools.map((entry) => entry.name)).not.toContain("screen");
            await expect(
              bridge.handleToolCall({
                threadId: "parent-1",
                turnId: "private-completion",
                callId: "denied-private-screen",
                namespace: "openclaw",
                tool: "screen",
                arguments: { action: "sidebar_show" },
              }),
            ).resolves.toMatchObject({
              success: false,
              contentItems: [
                { type: "inputText", text: "OpenClaw tool is not available for this turn: screen" },
              ],
            });
          }
          const binding = await startOrResumeThread({
            client: fixture.client,
            params: turn,
            cwd: workspaceDir,
            dynamicTools: bridge.specs,
            appServer: createThreadLifecycleAppServerOptions(),
            signal: new AbortController().signal,
          });
          ids.push(binding.threadId);
          expect(
            await retainCodexAppServerLiveThread(
              fixture.client,
              binding.threadId,
              binding.liveThreadOwnership?.release,
              binding.liveThreadConfigFingerprint,
            ),
          ).toBe(true);
          if (ids.length === 1) {
            releaseProtection = protectCodexAppServerLiveThread(fixture.client, binding.threadId);
            expect(isCodexAppServerLiveThreadProtected(fixture.client, binding.threadId)).toBe(
              true,
            );
          }
        }
        expect(ids).toEqual(["parent-1", "parent-1", "parent-1"]);
      } finally {
        releaseProtection?.();
      }
    },
  );

  it.each(["schema", "configured deny", "shell description"] as const)(
    "invalidates fresh core %s without weakening protected-thread invalidation",
    async (change) => {
      const { workspaceDir, agentDir } = createRunPaths();
      const params = createRunParams();
      params.disableTools = false;
      setCodexTestModelSupportsTools(params, true);
      params.senderIsOwner = true;
      params.config = {
        tools: {
          allow: change === "shell description" ? ["exec", "process"] : ["sessions"],
          exec: { mode: "ask" },
        },
      };
      const declarations = async () => {
        const host = await createAdmittedHostCapabilityTestFixture(params);
        onTestFinished(() => {
          host.closeHost();
          host.closeAdmission();
        });
        params.hostCapabilities = host.hostCapabilities;
        return buildDynamicDeclarationsForTest(params, workspaceDir, {
          ignoreRuntimePlan: true,
          nativeToolSurfaceEnabled: change !== "shell description",
        });
      };
      const fixture = await createParentContinuityHarness(agentDir);
      let releaseProtection: (() => void) | undefined;
      const start = (dynamicTools: CodexDynamicToolSpec[]) =>
        startOrResumeThread({
          client: fixture.client,
          params,
          cwd: workspaceDir,
          dynamicTools,
          appServer: createThreadLifecycleAppServerOptions(),
          signal: new AbortController().signal,
        });
      try {
        const initial = await declarations();
        const bridge = createCodexToolBridgeForTest(params, [], initial);
        const binding = await start(bridge.specs);
        expect(
          await retainCodexAppServerLiveThread(
            fixture.client,
            binding.threadId,
            binding.liveThreadOwnership?.release,
            binding.liveThreadConfigFingerprint,
          ),
        ).toBe(true);
        releaseProtection = protectCodexAppServerLiveThread(fixture.client, binding.threadId);
        // A real core schema change: collectors cannot advertise session stop.
        if (change === "schema") {
          params.swarmCollector = true;
        } else if (change === "shell description") {
          params.config = { tools: { allow: ["exec", "process"], exec: { mode: "auto" } } };
        } else {
          params.config = { tools: { allow: ["sessions"], deny: ["sessions"] } };
        }
        const next = await declarations();
        if (change !== "configured deny") {
          expect(next.map((tool) => tool.name)).toEqual(initial.map((tool) => tool.name));
          if (change === "schema") {
            expect(next[0]?.parameters).not.toEqual(initial[0]?.parameters);
          }
          expect(next[0]?.description).not.toEqual(initial[0]?.description);
        } else {
          expect(next).toEqual([]);
        }
        const changed = createCodexDynamicToolBridge({
          tools: [],
          registeredTools: next,
          signal: new AbortController().signal,
        });
        if (change === "configured deny") {
          // The existing empty-catalog path preserves the protected parent
          // and starts a transient no-tool thread rather than retiring it.
          const replacement = await start(changed.specs);
          expect(replacement.threadId).toBe("parent-2");
          expect(replacement.lifecycle).toMatchObject({ preserveExistingBinding: true });
          expect(isCodexAppServerLiveThreadProtected(fixture.client, "parent-1")).toBe(true);
          return;
        }
        await expect(start(changed.specs)).rejects.toThrow(
          "Codex thread parent-1 is claimed by active work; stop it first.",
        );
        expect(
          fixture.request.mock.calls.filter(([method]) => method === "thread/start"),
        ).toHaveLength(1);
        expect(isCodexAppServerLiveThreadProtected(fixture.client, "parent-1")).toBe(true);
        assert(releaseProtection);
        releaseProtection();
        releaseProtection = undefined;
        expect((await start(changed.specs)).threadId).toBe("parent-2");
      } finally {
        releaseProtection?.();
      }
    },
  );

  it("keeps the parent through run-attempt private completion with the full core profile", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    let starts = 0;
    const turnThreads: string[] = [];
    const harness = createStartedThreadHarness(
      async (method, input) => {
        // Full profile permits native search. Keep the simulated provider's
        // capability stable before and after learning the thread's provider.
        if (method === "modelProvider/capabilities/read") {
          return { webSearch: true };
        }
        if (method === "thread/start") {
          return threadStartResult(`parent-${++starts}`);
        }
        if (method === "thread/resume") {
          assert(isJsonObject(input) && typeof input.threadId === "string");
          return threadStartResult(input.threadId);
        }
        if (method === "turn/start") {
          assert(isJsonObject(input) && typeof input.threadId === "string");
          turnThreads.push(input.threadId);
          return turnStartResult();
        }
        return undefined;
      },
      { persistedThreads: [] },
    );
    for (const senderIsOwner of [true, false, true]) {
      const params = createParams(sessionFile, workspaceDir);
      params.disableTools = false;
      params.senderIsOwner = senderIsOwner;
      params.messageChannel = "discord";
      params.messageProvider = "discord";
      params.config = {
        tools: { profile: "full", alsoAllow: ["sessions", "gateway", "plugins"] },
        agents: { defaults: { workspace: workspaceDir } },
      };
      if (!senderIsOwner) {
        params.sourceReplyDeliveryMode = "automatic";
        params.inputProvenance = {
          kind: "inter_session",
          sourceSessionKey: "agent:main:subagent:child",
          sourceTool: "subagent_announce",
        };
      }
      setCodexTestModelSupportsTools(params, true);
      const host = await createAdmittedHostCapabilityTestFixture(params, {
        nativeModelPolicySupport: "exact",
      });
      params.hostCapabilities = host.hostCapabilities;
      params.agentHarnessCompletionScope = host.agentHarnessCompletionScope;
      try {
        const run = runCodexAppServerAttempt(params);
        await awaitGateBeforeSettlement(
          run.waitForTurnAccepted(),
          run,
          "attempt settled before turn acceptance",
        );
        const threadId = turnThreads.at(-1);
        assert(threadId);
        await harness.completeTurn({ threadId, turnId: "turn-1" });
        const result = await run;
        expect(readAttemptTerminal(result)).toMatchObject({ aborted: false, timedOut: false });
      } finally {
        host.closeHost();
        host.closeAdmission();
      }
    }
    expect(turnThreads).toEqual(["parent-1", "parent-1", "parent-1"]);
  });

  it("preserves prepared executable definitions over the fresh declaration surface", async () => {
    const { workspaceDir } = createRunPaths();
    const params = createRunParams();
    params.disableTools = false;
    params.config = { tools: { allow: ["sessions_spawn", "agents_wait"] } };
    setCodexTestModelSupportsTools(params, true);
    const host = await createAdmittedHostCapabilityTestFixture(params);
    onTestFinished(() => {
      host.closeHost();
      host.closeAdmission();
    });
    params.hostCapabilities = host.hostCapabilities;
    const tools = await buildDynamicToolsForTest(params, workspaceDir);
    const registered = await buildDynamicDeclarationsForTest(params, workspaceDir);
    expect(registered.find((tool) => tool.name === "sessions_spawn")?.parameters).toHaveProperty(
      "properties.collect",
    );
    const bridge = createCodexToolBridgeForTest(
      params,
      tools.filter((tool) => tool.name !== "agents_wait"),
      registered,
    );
    expect(
      flattenCodexDynamicToolFunctions(bridge.specs).find((tool) => tool.name === "sessions_spawn")
        ?.inputSchema,
    ).not.toHaveProperty("properties.collect");
  });

  it("rejects declaration publication when its host closes after the host read", async () => {
    const { workspaceDir } = createRunPaths();
    const params = createRunParams();
    params.disableTools = false;
    params.config = { tools: { allow: ["sessions"] } };
    setCodexTestModelSupportsTools(params, true);
    const host = await createAdmittedHostCapabilityTestFixture(params);
    onTestFinished(() => {
      host.closeHost();
      host.closeAdmission();
    });
    params.hostCapabilities = {
      ...host.hostCapabilities,
      readCoreToolDeclarations: (tools) => {
        const data = host.hostCapabilities.readCoreToolDeclarations!(tools);
        host.closeHost();
        return data;
      },
    };
    await expect(buildDynamicDeclarationsForTest(params, workspaceDir)).rejects.toThrow(
      /active|closed/,
    );
  });
});
