import assert from "node:assert/strict";
import path from "node:path";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { runWithCronCreatorAuthorityCapabilityResolver } from "openclaw/plugin-sdk/codex-mcp-projection";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCronAuthorityCapabilityFixture } from "./codex-app-server.test-fixtures.js";
import { flattenSpecsWithNamespace } from "./dynamic-tools.test-support.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import type {
  CodexThreadResumeParams,
  CodexThreadStartParams,
  CodexTurnStartParams,
} from "./protocol.js";
import {
  createCodexRuntimePlanFixture,
  createParams,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";

type RequestParams = {
  "thread/start": CodexThreadStartParams;
  "thread/resume": CodexThreadResumeParams;
  "turn/start": CodexTurnStartParams;
};

function getRequestParams<M extends keyof RequestParams>(
  requests: ReadonlyArray<{ method: string; params?: unknown }>,
  method: M,
): RequestParams[M] | undefined {
  return requests.find((request) => request.method === method)?.params as
    | RequestParams[M]
    | undefined;
}

function createRunPaths() {
  return {
    sessionFile: path.join(tempDir, "session.jsonl"),
    workspaceDir: path.join(tempDir, "workspace"),
  };
}

function enableRuntimeTools(params: EmbeddedRunAttemptParams) {
  params.disableTools = false;
  setCodexTestModelSupportsTools(params, true);
  params.runtimePlan = createCodexRuntimePlanFixture();
}

const channelOwnerManagementEntitlement = {
  source: "channel-owner" as const,
  isCurrent: () => true,
};

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt durable catalog stability", () => {
  it("reuses the settled thread across owner, inter_session failure notice, and owner turns while failing closed on turn 2", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const storePath = path.join(path.dirname(sessionFile), "sessions.json");
    const sessionKey = "agent:main:telegram:direct:owner";
    const config = {
      session: { store: storePath },
      tools: { web: { search: { enabled: false } } },
    };
    setRuntimeConfigSnapshot(config);
    const persistedDelivery = normalizeSessionDeliveryState({
      context: { channel: "telegram", to: "telegram:owner", accountId: "acct-1" },
      origin: { provider: "telegram", chatType: "direct" },
    });
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        delivery: persistedDelivery,
      },
    });

    let threadStarts = 0;
    let turnStarts = 0;
    const harness = createStartedThreadHarness(
      async (method, request) => {
        if (method === "thread/start") {
          return threadStartResult(`stable-catalog-thread-${++threadStarts}`);
        }
        if (method === "thread/resume") {
          return threadStartResult((request as CodexThreadResumeParams).threadId);
        }
        if (method === "turn/start") {
          return turnStartResult(`stable-catalog-turn-${++turnStarts}`);
        }
        return undefined;
      },
      { persistedThreads: [] },
    );
    const selectedToolNames = new Set(["automations", "openclaw", "ask_user", "gateway"]);
    const threadIds: string[] = [];
    const namespaces = new Map<string, string | null>();
    const turns = [
      { name: "owner-1", isInterSession: false },
      { name: "sessions-send-failure", isInterSession: true },
      { name: "owner-2", isInterSession: false },
    ] as const;
    for (const [index, { name, isInterSession }] of turns.entries()) {
      const runId = `stable-run-${name}`;
      const params = createParams(sessionFile, workspaceDir, { runId, sessionKey });
      Object.assign(params, {
        sessionTarget: { agentId: "main", sessionKey, sessionId: "session-1", storePath },
        config,
        senderIsOwner: !isInterSession,
        messageChannel: isInterSession ? "webchat" : "telegram",
        messageProvider: isInterSession ? "webchat" : "telegram",
        agentAccountId: isInterSession ? undefined : "acct-1",
        sessionPromptDelivery: persistedDelivery,
        ...(isInterSession
          ? {
              inputProvenance: {
                kind: "inter_session" as const,
                sourceChannel: "internal",
                sourceTool: "sessions_send",
              },
            }
          : {}),
      });
      enableRuntimeTools(params);
      const capability = isInterSession
        ? undefined
        : {
            ...createCronAuthorityCapabilityFixture(runId),
            callerOrigin: { kind: "external" as const, channel: "telegram" },
            managementEntitlement: channelOwnerManagementEntitlement,
          };
      if (capability) {
        params.cronCreatorAuthorityCapability = capability;
      }
      setCodexTestToolFactory(params, (options) =>
        createOpenClawCodingTools(options).filter((tool) => selectedToolNames.has(tool.name)),
      );
      const requestOffset = harness.requests.length;
      const runAttempt = () => runCodexAppServerAttempt(params);
      const run = capability
        ? runWithCronCreatorAuthorityCapabilityResolver({
            capability,
            runId,
            resolve: async () => ({
              tools: [],
              provenance: { version: 1, source: "final-executable-surface" },
            }),
            run: runAttempt,
          })
        : runAttempt();
      await run.waitForTurnAccepted();
      const requests = harness.requests.slice(requestOffset);
      const { threadId } = getRequestParams(requests, "turn/start")!;
      const turnId = `stable-catalog-turn-${index + 1}`;
      threadIds.push(threadId);
      if (index === 0) {
        const catalog = getRequestParams(requests, "thread/start")?.dynamicTools ?? [];
        for (const tool of flattenSpecsWithNamespace(catalog)) {
          namespaces.set(tool.name, tool.namespace ?? null);
        }
        expect(namespaces.has("automations")).toBe(true);
        expect(namespaces.has("openclaw")).toBe(true);
        expect(namespaces.has("gateway")).toBe(true);
        expect(namespaces.has("ask_user")).toBe(false);
      }
      if (isInterSession) {
        const onExitResponse = await harness.handleServerRequest({
          id: "rpc-on-exit",
          method: "item/tool/call",
          params: {
            threadId,
            turnId,
            callId: "call-on-exit",
            namespace: namespaces.get("automations") ?? null,
            tool: "automations",
            arguments: {
              action: "update",
              jobId: "job-1",
              job: { schedule: { kind: "on-exit", command: "make" } },
            },
          },
        });
        expect(onExitResponse).toMatchObject({ success: false });

        const addResponse = await harness.handleServerRequest({
          id: "rpc-add",
          method: "item/tool/call",
          params: {
            threadId,
            turnId,
            callId: "call-add",
            namespace: namespaces.get("automations") ?? null,
            tool: "automations",
            arguments: {
              action: "add",
              job: {
                name: "unauthorized",
                schedule: { kind: "every", everyMs: 60_000 },
                payload: { kind: "agentTurn", message: "blocked" },
              },
            },
          },
        });
        expect(JSON.stringify(addResponse)).toContain("needs the owner's authority");

        const gatewayResponse = await harness.handleServerRequest({
          id: "rpc-gateway",
          method: "item/tool/call",
          params: {
            threadId,
            turnId,
            callId: "call-gateway",
            namespace: namespaces.get("gateway") ?? null,
            tool: "gateway",
            arguments: { action: "restart" },
          },
        });
        expect(JSON.stringify(gatewayResponse)).toContain("needs the owner's authority");
      }
      await harness.completeTurn({ threadId, turnId });
      await run;
    }
    expect(threadStarts).toBe(1);
    expect(threadIds).toEqual([
      "stable-catalog-thread-1",
      "stable-catalog-thread-1",
      "stable-catalog-thread-1",
    ]);
  });

  it("reuses the settled thread across owner, managementOnly completion, and owner turns while rejecting add in execute()", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const config = { tools: { web: { search: { enabled: false } } } };
    setRuntimeConfigSnapshot(config);

    let threadStarts = 0;
    let turnStarts = 0;
    const harness = createStartedThreadHarness(
      async (method, request) => {
        if (method === "thread/start") {
          return threadStartResult(`mgmt-only-thread-${++threadStarts}`);
        }
        if (method === "thread/resume") {
          return threadStartResult((request as CodexThreadResumeParams).threadId);
        }
        if (method === "turn/start") {
          return turnStartResult(`mgmt-only-turn-${++turnStarts}`);
        }
        return undefined;
      },
      { persistedThreads: [] },
    );
    const threadIds: string[] = [];
    let automationsNamespace: string | null = null;
    const turns = [
      { name: "owner-1", managementOnly: false },
      { name: "subagent-completion", managementOnly: true },
      { name: "owner-2", managementOnly: false },
    ] as const;
    for (const [index, { name, managementOnly }] of turns.entries()) {
      const runId = `mgmt-run-${name}`;
      const params = createParams(sessionFile, workspaceDir, { runId });
      Object.assign(params, {
        config,
        senderIsOwner: true,
        ...(managementOnly
          ? {
              inputProvenance: {
                kind: "inter_session" as const,
                sourceChannel: "internal",
                sourceTool: "subagent_announce",
              },
            }
          : {}),
      });
      enableRuntimeTools(params);
      const capability = {
        ...createCronAuthorityCapabilityFixture(runId),
        callerOrigin: managementOnly
          ? ({ kind: "unknown" } as const)
          : ({ kind: "external", channel: "discord" } as const),
        managementEntitlement: channelOwnerManagementEntitlement,
      };
      params.cronCreatorAuthorityCapability = capability;
      setCodexTestToolFactory(params, (options) =>
        createOpenClawCodingTools(options).filter((tool) => tool.name === "automations"),
      );
      const requestOffset = harness.requests.length;
      const run = runWithCronCreatorAuthorityCapabilityResolver({
        capability,
        runId,
        resolve: async () => ({
          tools: [],
          provenance: { version: 1, source: "final-executable-surface" },
        }),
        run: () => runCodexAppServerAttempt(params),
      });
      await run.waitForTurnAccepted();
      const requests = harness.requests.slice(requestOffset);
      const { threadId } = getRequestParams(requests, "turn/start")!;
      const turnId = `mgmt-only-turn-${index + 1}`;
      threadIds.push(threadId);
      if (index === 0) {
        const catalog = getRequestParams(requests, "thread/start")?.dynamicTools ?? [];
        const automations = flattenSpecsWithNamespace(catalog).find(
          (tool) => tool.name === "automations",
        );
        assert(automations, "expected automations in the native catalog");
        automationsNamespace = automations.namespace ?? null;
      }
      if (managementOnly) {
        const addResponse = await harness.handleServerRequest({
          id: "rpc-mgmt-only-add",
          method: "item/tool/call",
          params: {
            threadId,
            turnId,
            callId: "call-mgmt-only-add",
            namespace: automationsNamespace,
            tool: "automations",
            arguments: {
              action: "add",
              job: {
                name: "blocked-add",
                schedule: { kind: "every", everyMs: 60_000 },
                payload: { kind: "agentTurn", message: "blocked" },
              },
            },
          },
        });
        expect(addResponse).toMatchObject({ success: false });
      }
      await harness.completeTurn({ threadId, turnId });
      await run;
    }
    expect(threadStarts).toBe(1);
    expect(threadIds).toEqual(["mgmt-only-thread-1", "mgmt-only-thread-1", "mgmt-only-thread-1"]);
  });

  it("keeps suggest_task and dismiss_task stable via listingClientCaps on internal turns while gating execution", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const storePath = path.join(path.dirname(sessionFile), "sessions.json");
    const sessionKey = "agent:main:dashboard:task-suggestions";
    const config = {
      session: { store: storePath },
      tools: { web: { search: { enabled: false } } },
    };
    setRuntimeConfigSnapshot(config);
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        clientCapabilities: ["task-suggestions"],
      },
    });

    let threadStarts = 0;
    let turnStarts = 0;
    const harness = createStartedThreadHarness(
      async (method, request) => {
        if (method === "thread/start") {
          return threadStartResult(`task-suggest-thread-${++threadStarts}`);
        }
        if (method === "thread/resume") {
          return threadStartResult((request as CodexThreadResumeParams).threadId);
        }
        if (method === "turn/start") {
          return turnStartResult(`task-suggest-turn-${++turnStarts}`);
        }
        return undefined;
      },
      { persistedThreads: [] },
    );
    const threadIds: string[] = [];
    const namespaces = new Map<string, string | null>();
    const turns = [
      { name: "ui-1", withGatewaySink: true },
      { name: "internal-wake", withGatewaySink: false },
      { name: "ui-2", withGatewaySink: true },
    ] as const;
    for (const [index, { name, withGatewaySink }] of turns.entries()) {
      const params = createParams(sessionFile, workspaceDir, {
        runId: `task-suggest-${name}`,
        sessionKey,
      });
      Object.assign(params, {
        sessionTarget: { agentId: "main", sessionKey, sessionId: "session-1", storePath },
        config,
        senderIsOwner: withGatewaySink,
        clientCaps: withGatewaySink ? ["task-suggestions"] : [],
        taskSuggestionDeliveryMode: withGatewaySink ? "gateway" : undefined,
        ...(withGatewaySink
          ? {}
          : {
              inputProvenance: {
                kind: "inter_session" as const,
                sourceChannel: "internal",
                sourceTool: "sessions_send",
              },
            }),
      });
      enableRuntimeTools(params);
      setCodexTestToolFactory(params, (options) =>
        createOpenClawCodingTools(options).filter((tool) =>
          ["suggest_task", "dismiss_task"].includes(tool.name),
        ),
      );
      const requestOffset = harness.requests.length;
      const run = runCodexAppServerAttempt(params);
      await run.waitForTurnAccepted();
      const requests = harness.requests.slice(requestOffset);
      const { threadId } = getRequestParams(requests, "turn/start")!;
      const turnId = `task-suggest-turn-${index + 1}`;
      threadIds.push(threadId);
      if (index === 0) {
        const catalog = getRequestParams(requests, "thread/start")?.dynamicTools ?? [];
        for (const tool of flattenSpecsWithNamespace(catalog)) {
          namespaces.set(tool.name, tool.namespace ?? null);
        }
        expect(namespaces.has("suggest_task")).toBe(true);
        expect(namespaces.has("dismiss_task")).toBe(true);
      }
      if (!withGatewaySink) {
        const suggestResponse = await harness.handleServerRequest({
          id: "rpc-gated-suggest",
          method: "item/tool/call",
          params: {
            threadId,
            turnId,
            callId: "call-gated-suggest",
            namespace: namespaces.get("suggest_task") ?? null,
            tool: "suggest_task",
            arguments: {
              title: "Follow up on logs",
              prompt: "Inspect logs/app.log for warnings.",
              tldr: "Avoid hidden production warnings.",
            },
          },
        });
        expect(JSON.stringify(suggestResponse)).toContain("task-suggestions");
        const dismissResponse = await harness.handleServerRequest({
          id: "rpc-gated-dismiss",
          method: "item/tool/call",
          params: {
            threadId,
            turnId,
            callId: "call-gated-dismiss",
            namespace: namespaces.get("dismiss_task") ?? null,
            tool: "dismiss_task",
            arguments: { task_id: "task_1" },
          },
        });
        expect(JSON.stringify(dismissResponse)).toContain("task-suggestions");
      }
      await harness.completeTurn({ threadId, turnId });
      await run;
    }
    expect(threadStarts).toBe(1);
    expect(threadIds).toEqual([
      "task-suggest-thread-1",
      "task-suggest-thread-1",
      "task-suggest-thread-1",
    ]);
  });

  it.each([
    { kind: "inter_session" as const, sourceTool: "sessions_send" },
    { kind: "internal_system" as const, sourceTool: "heartbeat" },
  ])(
    "isolates unexpected $kind dynamic-tool drift in a transient thread and preserves the warm owner binding",
    async ({ kind, sourceTool }) => {
      const { sessionFile, workspaceDir } = createRunPaths();
      const config = { tools: { web: { search: { enabled: false } } } };
      setRuntimeConfigSnapshot(config);

      let threadStarts = 0;
      let turnStarts = 0;
      const harness = createStartedThreadHarness(
        async (method, request) => {
          if (method === "thread/start") {
            return threadStartResult(`drift-${kind}-thread-${++threadStarts}`);
          }
          if (method === "thread/resume") {
            return threadStartResult((request as CodexThreadResumeParams).threadId);
          }
          if (method === "turn/start") {
            return turnStartResult(`drift-${kind}-turn-${++turnStarts}`);
          }
          return undefined;
        },
        { persistedThreads: [] },
      );

      const thirdPartyExecute = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "owner-only third-party result" }],
        details: {},
      }));
      const baseTool = createRuntimeDynamicTool("stable_core_tool");
      const thirdPartyOwnerTool = {
        ...createRuntimeDynamicTool("third_party_owner_tool"),
        execute: thirdPartyExecute,
      };
      const threadIds: string[] = [];
      const persistedAfterTurn: Array<string | undefined> = [];
      const turns = [
        { name: "owner-1", internal: false },
        { name: "internal-drift", internal: true },
        { name: "owner-2", internal: false },
      ] as const;

      for (const [index, { name, internal }] of turns.entries()) {
        const params = createParams(sessionFile, workspaceDir, {
          runId: `drift-${kind}-${name}`,
        });
        Object.assign(params, {
          config,
          senderIsOwner: !internal,
          pluginHarnessToolPolicyScope: "conversation",
          pluginHarnessToolPolicyRestricted: false,
          ...(internal
            ? {
                inputProvenance: {
                  kind,
                  sourceChannel: "internal",
                  sourceTool,
                },
              }
            : {}),
        });
        enableRuntimeTools(params);
        // Simulate a third-party plugin that ignores stableCatalog and omits its
        // owner-only tool whenever senderIsOwner === false.
        setCodexTestToolFactory(params, (options) =>
          options?.senderIsOwner === false ? [baseTool] : [baseTool, thirdPartyOwnerTool],
        );

        const requestOffset = harness.requests.length;
        const run = runCodexAppServerAttempt(params);
        await run.waitForTurnAccepted();
        const requests = harness.requests.slice(requestOffset);
        const { threadId } = getRequestParams(requests, "turn/start")!;
        const turnId = `drift-${kind}-turn-${index + 1}`;
        threadIds.push(threadId);

        if (internal) {
          const deniedResponse = await harness.handleServerRequest({
            id: `rpc-denied-${kind}`,
            method: "item/tool/call",
            params: {
              threadId,
              turnId,
              callId: `call-denied-${kind}`,
              namespace: null,
              tool: "third_party_owner_tool",
              arguments: {},
            },
          });
          expect(deniedResponse).toMatchObject({ success: false });
        }

        await harness.completeTurn({ threadId, turnId });
        await run;
        persistedAfterTurn.push((await readCodexAppServerBinding(sessionFile))?.threadId);
      }

      // Turn 2 runs on a transient thread (thread-2) without destroying thread-1,
      // so Turn 3 reuses thread-1 directly (2 thread/start calls, never 3).
      expect(threadStarts).toBe(2);
      expect(threadIds).toEqual([
        `drift-${kind}-thread-1`,
        `drift-${kind}-thread-2`,
        `drift-${kind}-thread-1`,
      ]);
      expect(persistedAfterTurn).toEqual([
        `drift-${kind}-thread-1`,
        `drift-${kind}-thread-1`,
        `drift-${kind}-thread-1`,
      ]);
      expect(thirdPartyExecute).not.toHaveBeenCalled();
    },
  );

  it("still rotates the persisted binding when an ordinary user turn changes the dynamic tool catalog", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const config = { tools: { web: { search: { enabled: false } } } };
    setRuntimeConfigSnapshot(config);

    let threadStarts = 0;
    let turnStarts = 0;
    const harness = createStartedThreadHarness(
      async (method, request) => {
        if (method === "thread/start") {
          return threadStartResult(`user-rotate-thread-${++threadStarts}`);
        }
        if (method === "thread/resume") {
          return threadStartResult((request as CodexThreadResumeParams).threadId);
        }
        if (method === "turn/start") {
          return turnStartResult(`user-rotate-turn-${++turnStarts}`);
        }
        return undefined;
      },
      { persistedThreads: [] },
    );

    const baseTool = createRuntimeDynamicTool("stable_core_tool");
    const addedTool = createRuntimeDynamicTool("newly_enabled_tool");
    const threadIds: string[] = [];
    for (const [index, includeAdded] of [false, true].entries()) {
      const params = createParams(sessionFile, workspaceDir, {
        runId: `user-rotate-${index + 1}`,
      });
      Object.assign(params, { config, senderIsOwner: true });
      enableRuntimeTools(params);
      setCodexTestToolFactory(params, () => (includeAdded ? [baseTool, addedTool] : [baseTool]));

      const requestOffset = harness.requests.length;
      const run = runCodexAppServerAttempt(params);
      await run.waitForTurnAccepted();
      const requests = harness.requests.slice(requestOffset);
      const { threadId } = getRequestParams(requests, "turn/start")!;
      threadIds.push(threadId);
      await harness.completeTurn({ threadId, turnId: `user-rotate-turn-${index + 1}` });
      await run;
    }

    expect(threadStarts).toBe(2);
    expect(threadIds).toEqual(["user-rotate-thread-1", "user-rotate-thread-2"]);
    expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe("user-rotate-thread-2");
  });
});
