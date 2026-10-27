import path from "node:path";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { expect, it, vi } from "vitest";
import { retainCodexAppServerLiveThread } from "./client-runtime.js";
import { CodexAppServerRpcError } from "./client.js";
import {
  createCodexManagedThreadStore,
  type StoredCodexManagedThread,
} from "./managed-thread-store.js";
import { isJsonObject, type RpcRequest } from "./protocol.js";
import { tempDir, threadStartResult } from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import { getCurrentSharedClientEntry } from "./shared-client-lifecycle.js";
import {
  releaseLeasedSharedCodexAppServerClient,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import { registerThreadOrphanRecoveryTests } from "./thread-lifecycle-orphan-recovery.test-support.js";
import type { PolicyRefreshFixtures } from "./thread-lifecycle.test-fixtures.js";

/** Keep cold recovery and policy refresh under the binding suite's existing lifecycle custody. */
export function registerThreadPolicyRefreshTests(fixtures: PolicyRefreshFixtures) {
  const {
    createParams,
    createThreadLifecycleAppServerOptions,
    createLeasedLifecycleWireClient,
    startOrResumeThread,
    writeCodexAppServerBinding,
  } = fixtures;
  registerThreadOrphanRecoveryTests(fixtures);
  it.each([
    "instructions",
    "model",
    "model and instructions",
    "lost history",
    "unowned",
    "policy change",
    "tool change",
    "ambiguous response",
    "post-write RPC error",
    "fork overload",
    "source identity",
    "active history",
    "binding conflict",
    "policy rejected",
    "policy response lost",
  ])("preserves settled failed remote history across a %s handoff", async (change) => {
    const sessionFile = path.join(tempDir, "settled-remote-handoff.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const sourceId = "failed-remote-source";
    const replacementId = "failed-remote-replacement";
    const source = threadStartResult(sourceId);
    const turns = [
      {
        id: "completed-effect-turn",
        status: "completed",
        error: null,
        items: [{ id: "effect", type: "commandExecution", status: "completed" }],
      },
      { id: "failed-auth-turn", status: "failed", error: { message: "401" }, items: [] },
    ];
    const managed = new Map<string, StoredCodexManagedThread>();
    const previousManagedStore = testCodexAppServerBindingStore.managedThreads;
    testCodexAppServerBindingStore.managedThreads = createCodexManagedThreadStore({
      entries: async () => [...managed].map(([key, value]) => ({ key, value, createdAt: 0 })),
      registerIfAbsent: async (key, value) => {
        if (managed.has(key)) {
          return false;
        }
        managed.set(key, value);
        return true;
      },
    });
    const requests: RpcRequest[] = [];
    const events: string[] = [];
    let policyWritten = false;
    const wire = await createLeasedLifecycleWireClient(
      path.join(tempDir, "agent"),
      (request) => {
        requests.push(request);
        events.push(request.method);
        const requestParams = isJsonObject(request.params) ? request.params : {};
        if (request.method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (request.method === "configRequirements/read") {
          return { requirements: null };
        }
        if (request.method === "thread/start") {
          return requests.filter(({ method }) => method === "thread/start").length > 1
            ? { ...source, thread: { ...source.thread, id: replacementId } }
            : source;
        }
        if (request.method === "thread/turns/list") {
          if (requestParams.threadId === replacementId && change === "lost history") {
            return { data: [], nextCursor: null };
          }
          const page = requestParams.cursor ? turns.slice(1) : turns.slice(0, 1);
          return {
            data:
              change === "active history"
                ? page.map((turn) => ({ ...turn, status: "inProgress" }))
                : page,
            nextCursor: requestParams.cursor ? null : "second-page",
          };
        }
        if (request.method === "thread/read") {
          const replacement = requestParams.threadId === replacementId;
          return {
            thread: {
              ...source.thread,
              id: replacement ? replacementId : sourceId,
              status: { type: replacement ? "idle" : "systemError" },
              turns: replacement && change === "lost history" ? [] : turns,
            },
          };
        }
        if (request.method === "thread/fork") {
          if (change === "ambiguous response") {
            return {};
          }
          if (change === "fork overload") {
            throw new CodexAppServerRpcError(
              { code: -32001, message: "server overloaded" },
              "thread/fork",
            );
          }
          if (change === "post-write RPC error") {
            throw new CodexAppServerRpcError(
              { code: -32603, message: "metadata failed after fork creation" },
              "thread/fork",
            );
          }
          return {
            ...source,
            model: requestParams.model ?? source.model,
            thread: {
              ...source.thread,
              id: change === "source identity" ? sourceId : replacementId,
              status: { type: "idle" },
              // Fork requests exclude inline turns; admission reads every full page.
              turns: [],
            },
          };
        }
        if (request.method === "thread/unsubscribe") {
          return { status: "unsubscribed" };
        }
        if (request.method === "thread/inject_items") {
          if (change === "policy rejected") {
            throw new CodexAppServerRpcError(
              { code: -32602, message: "policy rejected before write" },
              "thread/inject_items",
            );
          }
          policyWritten = true;
          if (change === "policy response lost") {
            throw new CodexAppServerRpcError(
              { code: -32603, message: "policy persisted before reply failed" },
              "thread/inject_items",
            );
          }
          return {};
        }
        if (request.method === "thread/delete" || request.method === "thread/archive") {
          return {};
        }
        throw new Error(`unexpected method: ${request.method}`);
      },
      "websocket",
    );
    const appServer = createThreadLifecycleAppServerOptions();
    appServer.start = { ...appServer.start, transport: "websocket", url: "ws://127.0.0.1:8123" };
    const common = {
      client: wire.client,
      params: { ...createParams(sessionFile, workspaceDir), agentDir: path.join(tempDir, "agent") },
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      userMcpServersEnabled: false,
      signal: new AbortController().signal,
    };
    try {
      const first = await startOrResumeThread({ ...common, developerInstructions: "initial" });
      await retainCodexAppServerLiveThread(
        wire.client,
        first.threadId,
        undefined,
        first.liveThreadConfigFingerprint,
      );
      expect(getCurrentSharedClientEntry(wire.client)).toBeDefined();
      if (change === "unowned") {
        testCodexAppServerBindingStore.managedThreads = undefined;
      }
      const mutate = testCodexAppServerBindingStore.mutate.bind(testCodexAppServerBindingStore);
      vi.spyOn(testCodexAppServerBindingStore, "mutate").mockImplementation(
        (identity, mutation, ...rest) => {
          events.push(`binding:${mutation.kind}`);
          return change === "binding conflict" && mutation.kind === "replace-thread"
            ? Promise.resolve(false)
            : mutate(identity, mutation, ...rest);
        },
      );
      const resumed = startOrResumeThread({
        ...common,
        developerInstructions: change === "model" ? "initial" : "updated instructions",
        ...(["model", "model and instructions"].includes(change)
          ? { runtimeModelId: "gpt-5.4-mini" }
          : {}),
        ...(change === "policy change" ? { nativeHookRelayGeneration: "changed-generation" } : {}),
        ...(change === "tool change"
          ? {
              dynamicTools: [
                {
                  type: "function" as const,
                  name: "changed",
                  description: "changed tool",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            }
          : {}),
      });
      const failures: Record<string, RegExp> = {
        "lost history": /complete recorded history/,
        unowned: /unowned or protected/,
        "policy change": /nativeHookRelayGeneration changed/,
        "active history": /settled terminal failure/,
        "ambiguous response": /thread\/fork response/,
        "post-write RPC error": /fork was not confirmed/,
        "source identity": /reused its source identity/,
        "binding conflict": /binding changed/,
        "policy rejected": /policy rejected before write/,
        "policy response lost": /policy persisted before reply failed/,
      };
      if (change === "fork overload") {
        await expect(resumed).rejects.toBeInstanceOf(CodexAppServerRpcError);
        expect(getCurrentSharedClientEntry(wire.client)).toBeDefined();
        expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe(sourceId);
      } else if (failures[change]) {
        await expect(resumed).rejects.toBeInstanceOf(AgentHarnessPreflightError);
        await expect(resumed).rejects.toThrow(failures[change]);
        expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe(sourceId);
      } else {
        await expect(resumed).resolves.toMatchObject({
          threadId: change === "model" ? sourceId : replacementId,
          lifecycle: {
            action:
              change === "model" ? "resumed" : change === "tool change" ? "started" : "forked",
          },
        });
        expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe(
          change === "model" ? sourceId : replacementId,
        );
      }
      if (
        [
          "instructions",
          "model and instructions",
          "policy rejected",
          "policy response lost",
        ].includes(change)
      ) {
        const handoffs = requests.filter(({ method }) => method === "thread/inject_items");
        expect(handoffs).toHaveLength(1);
        expect(handoffs[0]?.params).toMatchObject({
          threadId: replacementId,
          items: [
            {
              type: "message",
              role: "developer",
              content: [
                { type: "input_text", text: expect.stringContaining("updated instructions") },
              ],
            },
          ],
        });
        expect(policyWritten).toBe(change !== "policy rejected");
        if (change === "instructions" || change === "model and instructions") {
          expect(events.indexOf("binding:replace-thread")).toBeGreaterThan(
            events.indexOf("thread/inject_items"),
          );
        } else {
          expect(events).not.toContain("binding:replace-thread");
        }
      }
      const fork = requests.find(({ method }) => method === "thread/fork");
      if (["model", "unowned", "policy change", "tool change", "active history"].includes(change)) {
        expect(fork).toBeUndefined();
      } else {
        expect(fork?.params).toMatchObject({ threadId: sourceId, deferGoalContinuation: true });
        expect(fork?.params).not.toHaveProperty("beforeTurnId");
        expect(fork?.params).not.toHaveProperty("lastTurnId");
        // Only the native client's proven pre-enqueue overload contract retries writes.
        expect(requests.filter(({ method }) => method === "thread/fork")).toHaveLength(
          change === "fork overload" ? 4 : 1,
        );
      }
      expect(requests.filter(({ method }) => method === "thread/start")).toHaveLength(
        change === "tool change" ? 2 : 1,
      );
      if (
        ["lost history", "binding conflict", "policy rejected", "policy response lost"].includes(
          change,
        )
      ) {
        expect(
          requests.some(
            ({ method, params }) =>
              method === "thread/delete" &&
              isJsonObject(params) &&
              params.threadId === replacementId,
          ),
        ).toBe(true);
      }
      if (["ambiguous response", "source identity", "post-write RPC error"].includes(change)) {
        // Retirement detaches future acquisition while the existing lease drains.
        expect(getCurrentSharedClientEntry(wire.client)).toBeUndefined();
        expect(
          requests.some(({ method }) => method === "thread/archive" || method === "thread/delete"),
        ).toBe(false);
      }
      expect(requests.some(({ method }) => method === "turn/start")).toBe(false);
      expect(
        requests.some(
          ({ method, params }) =>
            (method === "thread/archive" || method === "thread/delete") &&
            isJsonObject(params) &&
            params.threadId === sourceId,
        ),
      ).toBe(false);
    } finally {
      testCodexAppServerBindingStore.managedThreads = previousManagedStore;
      releaseLeasedSharedCodexAppServerClient(wire.client);
      wire.client.close();
    }
  });
  it.each([
    ...(["stdio", "websocket", "unix", "proxy"] as const).map((transport) => ({
      developerInstructions: "replacement policy",
      fault: "none",
      transport,
    })),
    { developerInstructions: "", fault: "none", transport: "stdio" as const },
    ...["unload", "client retired", "unknown write", "retirement failure", "binding commit"].map(
      (fault) => ({
        developerInstructions: "replacement policy",
        fault,
        transport: "stdio" as const,
      }),
    ),
  ])(
    "refreshes ordinary generic policy over $transport before admitting a resumed turn: $developerInstructions / $fault",
    async ({ developerInstructions, fault, transport }) => {
      const sessionFile = path.join(tempDir, "ordinary-policy.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const threadId = "ordinary-policy";
      const response = threadStartResult(threadId);
      const requests: RpcRequest[] = [];
      const wire = await createLeasedLifecycleWireClient(
        path.join(tempDir, "agent"),
        (request) => {
          requests.push(request);
          if (request.method === "config/read") {
            return { config: {}, origins: {}, layers: [] };
          }
          if (request.method === "configRequirements/read") {
            return { requirements: null };
          }
          if (request.method === "thread/read") {
            return {
              thread: {
                ...response.thread,
                status: { type: fault === "unload" ? "idle" : "notLoaded" },
              },
            };
          }
          if (request.method === "thread/resume") {
            if (fault === "client retired") {
              retireSharedCodexAppServerClientIfCurrent(wire.client);
            }
            return response;
          }
          if (request.method === "thread/inject_items") {
            if (fault === "unknown write" || fault === "retirement failure") {
              throw new CodexAppServerRpcError(
                { code: -32603, message: "policy flush failed after write" },
                "thread/inject_items",
              );
            }
            return {};
          }
          if (request.method === "thread/unsubscribe") {
            return { status: "unsubscribed" };
          }
          throw new Error(`unexpected method: ${request.method}`);
        },
        transport,
      );
      await writeCodexAppServerBinding(sessionFile, { threadId, cwd: workspaceDir });
      const before = await readCodexAppServerBinding(sessionFile);
      if (fault === "binding commit") {
        vi.spyOn(testCodexAppServerBindingStore, "mutate").mockRejectedValueOnce(
          new Error("binding commit failed"),
        );
      }
      try {
        const run = startOrResumeThread({
          client: wire.client,
          params: {
            ...createParams(sessionFile, workspaceDir),
            agentDir: path.join(tempDir, "agent"),
          },
          cwd: workspaceDir,
          dynamicTools: [],
          appServer: createThreadLifecycleAppServerOptions(),
          userMcpServersEnabled: false,
          developerInstructions,
          signal: new AbortController().signal,
          ...(fault === "retirement failure"
            ? {
                abandonClient: async () => {
                  throw new Error("client retirement failed");
                },
              }
            : {}),
        });
        if (fault !== "none") {
          await expect(run).rejects.toBeInstanceOf(AgentHarnessPreflightError);
          await expect(run).rejects.toMatchObject({
            name: "CodexThreadPolicyHandoffError",
            scope: undefined,
            outcome:
              fault === "unknown write" || fault === "retirement failure"
                ? "unknown"
                : fault === "binding commit"
                  ? "acknowledged"
                  : "not-written",
          });
          expect(await readCodexAppServerBinding(sessionFile)).toEqual(before);
          expect(requests.filter(({ method }) => method === "thread/resume")).toHaveLength(1);
          expect(requests.filter(({ method }) => method === "thread/inject_items")).toHaveLength(
            fault === "unknown write" ||
              fault === "retirement failure" ||
              fault === "binding commit"
              ? 1
              : 0,
          );
          expect(requests.some(({ method }) => method === "thread/start")).toBe(false);
          return;
        }
        expect((await run).threadId).toBe(threadId);
        expect(requests.map(({ method }) => method)).toEqual([
          "config/read",
          "configRequirements/read",
          "thread/read",
          "thread/resume",
          "thread/inject_items",
        ]);
        const policy = JSON.stringify(requests.at(-1)?.params);
        expect(policy).toContain(
          developerInstructions || "earlier OpenClaw generic policy is withdrawn",
        );
        expect(policy).toContain("It replaces earlier OpenClaw-supplied generic policy");
        expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe(threadId);
      } finally {
        releaseLeasedSharedCodexAppServerClient(wire.client);
        wire.client.close();
      }
    },
  );

  it.each([
    { nativeStatus: "idle", transport: "websocket" as const },
    { nativeStatus: "systemError", transport: "stdio" as const },
    { nativeStatus: "active", transport: "stdio" as const },
  ])(
    "keeps ordinary warm configuration honest over $transport across $nativeStatus",
    async ({ nativeStatus, transport }) => {
      const developerInstructions = "replacement policy";
      const sessionFile = path.join(tempDir, "ordinary-warm-policy.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const threadId = "ordinary-warm-policy";
      const response = threadStartResult(threadId);
      const methods: string[] = [];
      let subscribed = true;
      const wire = await createLeasedLifecycleWireClient(
        path.join(tempDir, "agent"),
        (request) => {
          methods.push(request.method);
          if (request.method === "thread/unsubscribe" || request.method === "thread/resume") {
            expect(request.params).toMatchObject({ threadId });
          }
          if (request.method === "config/read") {
            return { config: {}, origins: {}, layers: [] };
          }
          if (request.method === "configRequirements/read") {
            return { requirements: null };
          }
          if (request.method === "thread/start" || request.method === "thread/resume") {
            if (!subscribed && nativeStatus === "idle") {
              wire.send({
                method: "thread/status/changed",
                params: { threadId, status: { type: "notLoaded" } },
              });
            }
            subscribed = true;
            return response;
          }
          if (request.method === "thread/read") {
            return { thread: { ...response.thread, status: { type: nativeStatus } } };
          }
          if (request.method === "thread/unsubscribe") {
            subscribed = false;
            return { status: "unsubscribed" };
          }
          if (request.method === "thread/inject_items") {
            return {};
          }
          throw new Error(`unexpected method: ${request.method}`);
        },
        transport,
      );
      const common = {
        client: wire.client,
        params: {
          ...createParams(sessionFile, workspaceDir),
          agentDir: path.join(tempDir, "agent"),
        },
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        userMcpServersEnabled: false,
        signal: new AbortController().signal,
      };
      try {
        const first = await startOrResumeThread({
          ...common,
          developerInstructions: "initial policy",
        });
        await retainCodexAppServerLiveThread(
          wire.client,
          first.threadId,
          undefined,
          first.liveThreadConfigFingerprint,
        );
        const resume = startOrResumeThread({ ...common, developerInstructions });
        if (nativeStatus === "active") {
          await expect(resume).rejects.toThrow("Codex session became active in another runner");
          expect(methods).toEqual([
            "config/read",
            "configRequirements/read",
            "thread/start",
            "config/read",
            "configRequirements/read",
            "thread/read",
          ]);
          expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe(first.threadId);
          return;
        }
        if (nativeStatus === "systemError") {
          await expect(resume).rejects.toThrow("did not confirm unloading");
          expect(methods).not.toContain("thread/inject_items");
          expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe(first.threadId);
          return;
        }
        const second = await resume;
        expect(second.threadId).toBe(first.threadId);
        expect(methods).toEqual([
          "config/read",
          "configRequirements/read",
          "thread/start",
          "config/read",
          "configRequirements/read",
          "thread/read",
          "thread/unsubscribe",
          "thread/resume",
          "thread/inject_items",
        ]);
      } finally {
        releaseLeasedSharedCodexAppServerClient(wire.client);
        wire.client.close();
      }
    },
  );
}
