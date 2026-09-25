import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { invokeNativeHookRelay } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { patchSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { hasCodexAppServerLiveThread } from "./client-runtime.js";
import {
  createCodexTestHostCapabilities,
  setCodexTestToolFactory,
} from "./host-capability.test-support.js";
import { buildCodexNativeHookRelayId } from "./native-hook-relay.js";
import {
  flattenCodexDynamicToolFunctions,
  type CodexThreadStartParams,
  type CodexTurnStartParams,
} from "./protocol.js";
import {
  createCodexRuntimePlanFixture,
  createParams,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexAppServerClientFactoryForTest,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
  userMessage,
} from "./run-attempt-test-harness.js";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import {
  ensureCodexSandboxExecServerEnvironment,
  releaseCodexSandboxExecServerEnvironment,
} from "./sandbox-exec-server.js";
import { createSandboxContext, openSocket, rpc } from "./sandbox-exec-server.test-helpers.js";
import type { CodexAppServerBindingStore } from "./session-binding.js";
import {
  readCodexAppServerBinding,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import {
  appendSqliteHistoryMessage,
  attachSqliteSessionTarget,
  readTranscriptMessagesByIdentity,
} from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();

type Actor = "maintainer" | "guest";
type Terminal = {
  actor: Actor;
  itemId: string;
  processId: string;
  command: string;
  cwd: string;
  alive: boolean;
  closed: Promise<unknown>;
  settled: Promise<unknown>;
};

function createSourceBoundHostCapabilities(signal: AbortSignal) {
  const bindModelExecution = () => ({
    signal,
    assertCurrent: () => signal.throwIfAborted(),
    release: () => {},
  });
  return createCodexTestHostCapabilities({
    bindModelExecution,
    retainSourceAuthority: () => ({
      ...bindModelExecution(),
      modelPolicyRequired: false,
      bindModelExecution,
    }),
  });
}

async function fixture(options: { failSettlement?: boolean } = {}) {
  // Keep the attempt budget under test control while sockets, workers, and real children progress.
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const sessionFile = path.join(tempDir, "native-owner-session.jsonl");
  const workspaceDir = path.join(tempDir, "workspace");
  const threadId = "qualification-shared-thread";
  const sessionScope = {
    agentId: "main",
    sessionKey: "agent:main:session-1",
    storePath: path.join(tempDir, "native-owner-sessions.json"),
  };
  await upsertSessionEntry({
    ...sessionScope,
    entry: { sessionId: "session-1", updatedAt: 1 },
  });
  const terminals = new Map<string, Terminal>();
  const terminated: Actor[] = [];
  const activeRuns: Array<{ controller: AbortController; run: Promise<unknown> }> = [];
  const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
  const backgroundCleanupFailed = createDeferred<void>();
  const turns: string[] = [];
  let socket: WebSocket | undefined;
  let registeredUrl: string | undefined;
  let retainedEnvironment: Awaited<ReturnType<typeof ensureCodexSandboxExecServerEnvironment>>;
  let bindingLeaseGate:
    | {
        entered: ReturnType<typeof createDeferred<void>>;
        release: ReturnType<typeof createDeferred<void>>;
      }
    | undefined;
  const withLease: CodexAppServerBindingStore["withLease"] = async (identity, run, leaseOptions) =>
    await testCodexAppServerBindingStore.withLease(
      identity,
      async () => {
        const gate = bindingLeaseGate;
        if (gate) {
          bindingLeaseGate = undefined;
          gate.entered.resolve();
          await gate.release.promise;
        }
        return await run();
      },
      leaseOptions,
    );
  const bindingStore = { ...testCodexAppServerBindingStore, withLease };
  const sandbox = createSandboxContext({
    ...(options.failSettlement
      ? {
          finalizeExec: async () => {
            throw new Error("fixture backend settlement failed");
          },
        }
      : {}),
    buildExecSpec: async () => ({
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write('qualification-ready\\n'); setTimeout(() => process.exit(0), 30000)",
      ],
      // Synthetic task-owned processes receive no inherited secrets or profile state.
      env: {},
      stdinMode: "pipe-closed",
    }),
  });
  Object.assign(sandbox, {
    sessionKey: "agent:main:session-1",
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    runtimeId: `native-terminal-${path.basename(tempDir)}`,
  });
  const harness = createStartedThreadHarness(async (method, raw) => {
    const input = raw as Record<string, unknown>;
    if (method === "environment/add") {
      const url = String(input.execServerUrl);
      if (registeredUrl !== url || socket?.readyState !== 1) {
        socket = await openSocket(url);
        registeredUrl = url;
      }
      return {};
    }
    if (method === "thread/start" || method === "thread/resume") {
      if (method === "thread/resume") {
        expect(input.threadId).toBe(threadId);
      }
      return threadStartResult(threadId, { cwd: "/workspace" });
    }
    if (method === "thread/read") {
      const requestedThreadId = typeof input.threadId === "string" ? input.threadId : threadId;
      return { thread: { ...threadStartResult(requestedThreadId).thread, turns: [] } };
    }
    if (method === "turn/start") {
      expect(input.threadId).toBe(threadId);
      expect(input.environments).toEqual([
        { environmentId: expect.stringMatching(/^openclaw-sandbox-/), cwd: "/workspace" },
      ]);
      const turnId = `qualification-turn-${turns.length + 1}`;
      turns.push(turnId);
      return turnStartResult(turnId);
    }
    if (method === "thread/backgroundTerminals/list") {
      expect(input.threadId).toBe(threadId);
      const data = [...terminals.values()]
        .filter((terminal) => terminal.alive)
        .map(({ itemId, processId, command, cwd }) => ({ itemId, processId, command, cwd }));
      return { data: input.limit ? data.slice(0, Number(input.limit)) : data, nextCursor: null };
    }
    if (method === "thread/backgroundTerminals/terminate") {
      expect(input.threadId).toBe(threadId);
      const terminal = terminals.get(String(input.processId));
      if (!terminal || !terminal.alive || !socket) {
        return { terminated: false };
      }
      await rpc(socket, "process/terminate", { processId: terminal.processId });
      await terminal.closed;
      terminated.push(terminal.actor);
      return { terminated: true };
    }
    return undefined;
  });

  const begin = async (actor: Actor, nativeChild?: { threadId: string; turnId: string }) => {
    const controller = new AbortController();
    const source = new AbortController();
    let completed = false;
    const admitted = createDeferred<void>();
    const params = createParams(sessionFile, workspaceDir, {
      runId: `${actor}-run-${turns.length + 1}`,
      prompt: `${actor} qualification turn`,
    });
    params.sessionTarget = { ...sessionScope, sessionId: params.sessionId };
    params.hostCapabilities = createSourceBoundHostCapabilities(source.signal);
    params.senderId = actor;
    params.onAgentEvent = (event) => {
      events.push(event);
      if (event.stream === "lifecycle" && event.data.phase === "start") {
        admitted.resolve();
      }
      if (
        event.stream === "codex_app_server.lifecycle" &&
        event.data.phase === "background_cleanup_failed"
      ) {
        backgroundCleanupFailed.resolve();
      }
    };
    params.sandbox = sandbox;
    params.abortSignal = controller.signal;
    params.runtimePlan = createCodexRuntimePlanFixture();
    setCodexTestModelSupportsTools(params, true);
    setCodexTestToolFactory(params, () => []);
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { experimental: { sandboxExecServer: true } } },
      bindingStore,
    });
    activeRuns.push({ controller, run });
    await Promise.race([
      admitted.promise,
      run.then(() => {
        throw new Error("Native process fixture attempt ended before admission");
      }),
    ]);
    if (turns.length > 1) {
      // A replaced relay keeps its retired listener for 250ms to reject stale callers.
      await vi.advanceTimersByTimeAsync(250);
    }
    const turnId = turns.at(-1)!;
    const commandThreadId = nativeChild?.threadId ?? threadId;
    const commandTurnId = nativeChild?.turnId ?? turnId;
    if (nativeChild) {
      await harness.notify({
        method: "thread/started",
        params: {
          thread: {
            id: nativeChild.threadId,
            parentThreadId: threadId,
            source: { subAgent: { thread_spawn: { parent_thread_id: threadId, depth: 1 } } },
          },
        },
      });
      // The registered monitor must claim the child from this exact accepted parent turn.
      await harness.notify({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            id: `${actor}-spawn`,
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: threadId,
            receiverThreadIds: [nativeChild.threadId],
          },
        },
      });
      await harness.notify({
        method: "turn/started",
        params: {
          threadId: nativeChild.threadId,
          turn: { id: nativeChild.turnId, status: "inProgress", items: [], error: null },
        },
      });
    }
    const server = await sandboxExecServerRegistry.servers.get(sandbox.runtimeId);
    if (!server || "node" in server || !socket) {
      throw new Error("Expected the real local sandbox exec-server owner");
    }
    const previousChildren = new Set(server.children);
    const processId = actor === "maintainer" ? "1001" : "2001";
    const relay = await invokeNativeHookRelay({
      provider: "codex",
      relayId: buildCodexNativeHookRelayId({
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      }),
      event: "pre_tool_use",
      rawPayload: {
        session_id: threadId,
        ...(nativeChild ? { agent_id: nativeChild.threadId } : {}),
        turn_id: commandTurnId,
        tool_name: "exec_command",
        tool_use_id: `${actor}-command`,
        tool_input: { command: "qualification-task-owned-process" },
      },
    });
    expect(relay.exitCode).toBe(0);
    await rpc(socket, "process/start", {
      processId,
      metadata: { threadId: commandThreadId, toolCallId: `${actor}-command` },
      argv: ["qualification-task-owned-process"],
      cwd: "file:///workspace",
      env: {},
      tty: false,
      pipeStdin: false,
      arg0: null,
    });
    const child = [...server.children].find((candidate) => !previousChildren.has(candidate));
    if (!child) {
      throw new Error("Real sandbox process owner was not admitted");
    }
    const terminal: Terminal = {
      actor,
      itemId: `${actor}-command`,
      processId,
      command: "qualification-task-owned-process",
      cwd: "/workspace",
      alive: true,
      closed: child.closed,
      settled: child.settled,
    };
    terminals.set(processId, terminal);
    void child.closed.then(async () => {
      terminal.alive = false;
      await harness.notify({
        method: "item/completed",
        params: {
          threadId: commandThreadId,
          turnId: commandTurnId,
          item: {
            id: terminal.itemId,
            type: "commandExecution",
            command: terminal.command,
            cwd: "/workspace",
            processId,
            status: "completed",
            commandActions: [],
            aggregatedOutput: "",
            exitCode: 0,
            durationMs: 1,
          },
        },
      });
    });
    await harness.notify({
      method: "item/started",
      params: {
        threadId: commandThreadId,
        turnId: commandTurnId,
        item: {
          id: terminal.itemId,
          type: "commandExecution",
          command: terminal.command,
          cwd: "/workspace",
          processId,
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: "",
          exitCode: null,
          durationMs: null,
        },
      },
    });
    return {
      terminal,
      turnId,
      controller,
      sourceSignal: source.signal,
      revoke: () => {
        source.abort(new Error("Synthetic original source revoked"));
        if (!completed) {
          controller.abort(source.signal.reason);
        }
      },
      run,
      complete: async (answer?: string) => {
        if (answer) {
          await harness.notify({
            method: "turn/completed",
            params: {
              threadId,
              turn: {
                id: turnId,
                status: "completed",
                items: [
                  {
                    id: `${actor}-answer`,
                    type: "agentMessage",
                    phase: "final_answer",
                    text: answer,
                  },
                ],
              },
            },
          });
        } else {
          await harness.completeTurn({ threadId, turnId });
        }
        const result = await run;
        completed = true;
        return result;
      },
    };
  };

  return {
    begin,
    terminated,
    events,
    backgroundCleanupFailed: backgroundCleanupFailed.promise,
    harness,
    sessionFile,
    threadId,
    armRetentionLeaseWait: () => {
      const gate = { entered: createDeferred<void>(), release: createDeferred<void>() };
      bindingLeaseGate = gate;
      return gate;
    },
    rotateSessionLineage: async () => {
      await patchSessionEntry({
        ...sessionScope,
        update: () => ({ previousSessionId: "session-predecessor-replaced" }),
      });
    },
    settleBackgroundProcess: async (terminal: Terminal) => {
      if (!socket) {
        throw new Error("Native process fixture socket is unavailable");
      }
      await rpc(socket, "process/terminate", { processId: terminal.processId });
      await terminal.closed;
      await terminal.settled;
    },
    retainSecondConsumer: async () => {
      // Same production lease operation used by a concurrent /btw turn or another
      // permitted session sharing this sandbox runtime; no fabricated process inventory.
      retainedEnvironment = await ensureCodexSandboxExecServerEnvironment({
        client: harness.client,
        sandbox,
        requireProcessAuthority: true,
      });
    },
    dispose: async () => {
      try {
        for (const { controller } of activeRuns) {
          controller.abort(new Error("fixture cleanup"));
        }
        await Promise.allSettled(activeRuns.map(({ run }) => run));
        if (retainedEnvironment) {
          await releaseCodexSandboxExecServerEnvironment(sandbox, retainedEnvironment);
          retainedEnvironment = undefined;
        }
        await sandboxExecServerRegistry.closeAll();
        socket?.terminate();
        harness.close();
      } finally {
        vi.useRealTimers();
      }
    },
  };
}

function createSandboxPolicyRun() {
  const params = createParams(
    path.join(tempDir, "managed-policy.jsonl"),
    path.join(tempDir, "workspace"),
  );
  const controller = new AbortController();
  const preparation: string[] = [];
  const exec = createRuntimeDynamicTool("exec");
  params.hostCapabilities = createSourceBoundHostCapabilities(controller.signal);
  params.sandbox = {
    ...createSandboxContext({}),
    sessionKey: params.sessionKey!,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.workspaceDir,
    runtimeId: `managed-policy-${path.basename(tempDir)}`,
  };
  params.abortSignal = controller.signal;
  params.runtimePlan = createCodexRuntimePlanFixture();
  setCodexTestModelSupportsTools(params, true);
  const selectTools = vi.fn(() => {
    preparation.push("tools");
    return [exec];
  });
  setCodexTestToolFactory(params, selectTools);
  return { params, controller, exec, preparation, selectTools };
}

describe("native background process source authority", () => {
  it("reports failed real-child settlement and preserves its command custody", async () => {
    const f = await fixture({ failSettlement: true });
    try {
      const guest = await f.begin("guest");
      await f.retainSecondConsumer();
      await guest.complete();
      guest.revoke();
      await expect(guest.terminal.settled).rejects.toThrow("fixture backend settlement failed");
      await f.backgroundCleanupFailed;
      expect(f.events).toContainEqual(
        expect.objectContaining({
          stream: "codex_app_server.lifecycle",
          data: expect.objectContaining({ phase: "background_cleanup_failed" }),
        }),
      );
      expect(guest.terminal.alive).toBe(false);
      await expect(f.begin("guest")).rejects.toThrow("unsettled native command identity");
    } finally {
      await f.dispose();
    }
  });

  it("sole sandbox lease normal completion settles its task-owned process", async () => {
    const f = await fixture();
    try {
      const staff = await f.begin("maintainer");
      expect(staff.terminal.alive).toBe(true);
      expect(readAttemptTerminal(await staff.complete()).aborted).toBe(false);
      await staff.terminal.settled;
      expect(staff.terminal.alive).toBe(false);
      expect(f.terminated).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  it("parent cancellation settles its claimed native child's process and preserves independent maintainer work", async () => {
    const f = await fixture();
    try {
      const staff = await f.begin("maintainer");
      await f.retainSecondConsumer();
      await staff.complete();
      expect(staff.terminal.alive).toBe(true);
      const guest = await f.begin("guest", {
        threadId: "guest-native-child",
        turnId: "guest-native-child-turn",
      });
      expect(guest.terminal.alive).toBe(true);
      guest.controller.abort(new Error("Synthetic parent foreground cancelled"));
      expect(readAttemptTerminal(await guest.run).aborted).toBe(true);
      expect(guest.sourceSignal.aborted).toBe(false);
      expect(f.harness.requests).toContainEqual({
        method: "turn/interrupt",
        params: { threadId: f.threadId, turnId: guest.turnId },
      });
      expect(guest.terminal.alive).toBe(false);
      await guest.terminal.settled;
      expect(f.terminated).toEqual([]);
      expect(staff.terminal.alive).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  it("preserves the earlier maintainer terminal when the later guest source ends on the reused thread", async () => {
    const f = await fixture();
    try {
      const staff = await f.begin("maintainer");
      await f.retainSecondConsumer();
      const completed = await staff.complete("Retained the running process for the next turn.");
      expect(readAttemptTerminal(completed).aborted).toBe(false);
      expect(completed.messagesSnapshot).toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          toolCallId: staff.terminal.itemId,
          isError: false,
          content: [{ type: "text", text: expect.stringContaining("still running") }],
          __openclaw: expect.objectContaining({
            toolOutput: expect.objectContaining({ outcome: "unknown" }),
          }),
        }),
      );
      expect(staff.terminal.alive).toBe(true);
      expect(f.terminated).toEqual([]);
      const guest = await f.begin("guest");
      expect((await readCodexAppServerBinding(f.sessionFile))?.threadId).toBe(f.threadId);
      expect(f.harness.requests.filter(({ method }) => method === "thread/start")).toHaveLength(1);
      expect(staff.terminal.alive).toBe(true);
      guest.revoke();
      await expect(guest.run).rejects.toBe(guest.sourceSignal.reason);
      expect(f.harness.requests).toContainEqual({
        method: "turn/interrupt",
        params: { threadId: f.threadId, turnId: guest.turnId },
      });
      await guest.terminal.settled;
      expect(guest.terminal.alive).toBe(false);
      expect(f.terminated).toEqual([]);
      expect(staff.terminal.alive).toBe(true);
    } finally {
      await f.dispose();
    }
  });
  it.each(["active", "settled"] as const)(
    "rechecks %s background custody at subscription retention",
    async (custody) => {
      const f = await fixture();
      try {
        const owner = await f.begin("maintainer");
        const lease = f.armRetentionLeaseWait();
        const completion = owner.complete();
        await lease.entered.promise;
        await f.rotateSessionLineage();
        if (custody === "settled") {
          await f.settleBackgroundProcess(owner.terminal);
          expect(owner.terminal.alive).toBe(false);
        } else {
          expect(owner.terminal.alive).toBe(true);
        }
        lease.release.resolve();
        if (custody === "active") {
          expect(readAttemptTerminal(await completion).aborted).toBe(false);
        } else {
          await expect(completion).rejects.toMatchObject({
            name: "AgentHarnessSessionSupersededError",
          });
        }
        expect(hasCodexAppServerLiveThread(f.harness.client, f.threadId)).toBe(
          custody === "active",
        );
      } finally {
        await f.dispose();
      }
    },
  );
  it("revokes completed guest work while a later maintainer foreground stays live", async () => {
    const f = await fixture();
    try {
      const guest = await f.begin("guest");
      await f.retainSecondConsumer();
      await guest.complete();
      const staff = await f.begin("maintainer");
      guest.revoke();
      await guest.terminal.settled;
      expect(guest.terminal.alive).toBe(false);
      expect(staff.terminal.alive).toBe(true);
      expect(f.harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
      expect(readAttemptTerminal(await staff.complete()).aborted).toBe(false);
    } finally {
      await f.dispose();
    }
  });
});

describe("managed-only Codex sandbox compatibility", () => {
  it.each(["fresh", "native catalog upgrade"] as const)(
    "executes the advertised sandbox alias under managed-only policy (%s)",
    async (mode) => {
      const f = createSandboxPolicyRun();
      const options = {
        pluginConfig: { appServer: { experimental: { sandboxExecServer: true } } },
      };
      const savedText = "Keep this saved conversation across the native catalog change.";
      let priorMessages: Array<Record<string, unknown>> = [];
      const createPolicyHarness = (managedOnly: boolean, threadId: string) => {
        const started = createDeferred<void>();
        const harness = createStartedThreadHarness(async (method) => {
          if (method === "configRequirements/read") {
            f.preparation.push(managedOnly ? "managed" : "allowed");
            return { requirements: { allowManagedHooksOnly: managedOnly } };
          }
          if (method === "thread/start") {
            return threadStartResult(threadId, { cwd: f.params.workspaceDir });
          }
          if (method === "thread/read") {
            return {
              thread: {
                ...threadStartResult("native-original").thread,
                status: { type: "notLoaded" },
                turns: [],
              },
            };
          }
          if (method === "turn/start") {
            started.resolve();
          }
          return undefined;
        });
        vi.spyOn(harness.client, "getInstanceId").mockReturnValue(`${threadId}-client`);
        return { ...harness, started: started.promise };
      };
      let harness = createPolicyHarness(mode === "fresh", "native-original");
      let run: ReturnType<typeof runCodexAppServerAttempt> | undefined;
      try {
        if (mode === "native catalog upgrade") {
          await attachSqliteSessionTarget(
            f.params,
            path.join(tempDir, "managed-history.sqlite"),
            f.params.sessionId,
          );
          await appendSqliteHistoryMessage(f.params, userMessage(savedText, 1));
          priorMessages = await readTranscriptMessagesByIdentity(f.params);
          run = runCodexAppServerAttempt(f.params, options);
          await Promise.race([harness.started, run]);
          await nextTurn();
          expect(
            harness.requests.find(({ method }) => method === "thread/start")?.params,
          ).toMatchObject({
            config: { "features.code_mode": true },
            environments: [expect.objectContaining({ environmentId: expect.any(String) })],
          });
          await harness.completeTurn({ threadId: "native-original", turnId: "turn-1" });
          expect(readAttemptTerminal(await run).aborted).toBe(false);
          expect((await readCodexAppServerBinding(f.params.sessionFile))?.threadId).toBe(
            "native-original",
          );
          harness.close();
          harness = createPolicyHarness(true, "managed-fallback");
          f.params.runId = "managed-policy-upgrade";
          f.preparation.length = 0;
        }
        run = runCodexAppServerAttempt(f.params, options);
        await Promise.race([harness.started, run]);
        await nextTurn();
        const start = harness.requests.find(({ method }) => method === "thread/start")
          ?.params as CodexThreadStartParams;
        const turn = harness.requests.find(({ method }) => method === "turn/start")
          ?.params as CodexTurnStartParams;
        expect(start).toMatchObject({
          environments: [],
          config: { "features.code_mode": false, "features.code_mode_only": false },
        });
        expect(turn.environments).toEqual([]);
        expect(f.preparation.indexOf("managed")).toBeGreaterThanOrEqual(0);
        expect(f.preparation.indexOf("managed")).toBeLessThan(f.preparation.indexOf("tools"));
        const alias = flattenCodexDynamicToolFunctions(start.dynamicTools ?? undefined).find(
          (tool) => tool.name === "sandbox_exec",
        );
        expect(alias).toBeDefined();
        const response = await harness.handleServerRequest({
          id: "managed-exec",
          method: "item/tool/call",
          params: {
            threadId: turn.threadId,
            turnId: "turn-1",
            callId: "managed-exec",
            namespace: null,
            tool: alias!.name,
            arguments: {},
          },
        });
        expect(response).toMatchObject({
          success: true,
          contentItems: [{ type: "inputText", text: "exec done" }],
        });
        expect(f.exec.execute).toHaveBeenCalledOnce();
        if (mode === "native catalog upgrade") {
          expect(JSON.stringify(turn.input)).toContain(savedText);
          expect(harness.requests.some(({ method }) => method === "thread/resume")).toBe(false);
        }
        await harness.completeTurn({ threadId: turn.threadId, turnId: "turn-1" });
        expect(readAttemptTerminal(await run).aborted).toBe(false);
        expect((await readCodexAppServerBinding(f.params.sessionFile))?.threadId).toBe(
          turn.threadId,
        );
        if (mode === "native catalog upgrade") {
          expect(turn.threadId).toBe("managed-fallback");
          expect(await readTranscriptMessagesByIdentity(f.params)).toEqual(
            expect.arrayContaining(priorMessages),
          );
        }
      } finally {
        f.controller.abort(new Error("managed policy fixture cleanup"));
        await Promise.allSettled([run]);
        harness.close();
      }
    },
  );

  it.each(["same client", "replacement client"] as const)(
    "revalidates managed hook policy at actual startup (%s)",
    async (mode) => {
      const f = createSandboxPolicyRun();
      let reads = 0;
      const planning = createStartedThreadHarness(async (method) => {
        if (method !== "configRequirements/read") {
          return undefined;
        }
        const managed = mode === "same client" && reads++ > 0;
        f.preparation.push(managed ? "managed" : "allowed");
        return { requirements: { allowManagedHooksOnly: managed } };
      });
      const startup =
        mode === "same client"
          ? planning
          : createStartedThreadHarness(async (method) => {
              if (method !== "configRequirements/read") {
                return undefined;
              }
              f.preparation.push("managed");
              return { requirements: { allowManagedHooksOnly: true } };
            });
      vi.spyOn(planning.client, "getInstanceId").mockReturnValue("planning-client");
      if (startup !== planning) {
        vi.spyOn(startup.client, "getInstanceId").mockReturnValue("startup-client");
      }
      let acquisitions = 0;
      setCodexAppServerClientFactoryForTest(async () =>
        acquisitions++ === 0 ? planning.client : startup.client,
      );
      try {
        await expect(
          runCodexAppServerAttempt(f.params, {
            pluginConfig: { appServer: { experimental: { sandboxExecServer: true } } },
          }),
        ).rejects.toThrow(/managed-only hooks.*OpenClaw native hook relay/i);
        expect(acquisitions).toBeGreaterThanOrEqual(2);
        expect(f.preparation.indexOf("allowed")).toBeLessThan(f.preparation.indexOf("tools"));
        expect(f.preparation.indexOf("tools")).toBeLessThan(f.preparation.indexOf("managed"));
        expect(
          [...planning.requests, ...startup.requests].filter(({ method }) =>
            ["thread/start", "thread/resume", "turn/start"].includes(method),
          ),
        ).toEqual([]);
        expect(f.exec.execute).not.toHaveBeenCalled();
      } finally {
        f.controller.abort();
        planning.close();
        startup.close();
      }
    },
  );

  it("bounds the early managed-hook policy read through the real native request owner", async () => {
    const f = createSandboxPolicyRun();
    const entered = createDeferred<void>();
    const pending = createDeferred<{ requirements: null }>();
    const harness = createStartedThreadHarness(
      async (method) => {
        if (method === "configRequirements/read") {
          entered.resolve();
          return await pending.promise;
        }
        return undefined;
      },
      { persistedThreads: [] },
    );
    await harness.client.initialize();
    setCodexAppServerClientFactoryForTest(async () => harness.client);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let outcome: { error?: unknown; completed?: true } | undefined;
    const run = runCodexAppServerAttempt(f.params, {
      pluginConfig: {
        appServer: { requestTimeoutMs: 100, experimental: { sandboxExecServer: true } },
      },
    });
    const settled = run.then(
      () => {
        outcome = { completed: true };
      },
      (error: unknown) => {
        outcome = { error };
      },
    );
    try {
      await Promise.race([entered.promise, settled]);
      await vi.advanceTimersByTimeAsync(101);
      await nextTurn();
      expect(outcome).toMatchObject({
        error: expect.objectContaining({
          message: expect.stringMatching(/configRequirements\/read.*timed out/i),
        }),
      });
      expect(f.selectTools).not.toHaveBeenCalled();
      expect(
        harness.requests.filter(({ method }) =>
          ["thread/start", "thread/resume", "turn/start"].includes(method),
        ),
      ).toEqual([]);
    } finally {
      f.controller.abort();
      pending.resolve({ requirements: null });
      await settled;
      vi.useRealTimers();
      harness.close();
    }
  });
});
