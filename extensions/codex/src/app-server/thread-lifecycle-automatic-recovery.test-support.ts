import path from "node:path";
import { expect, it } from "vitest";
import {
  createCodexManagedThreadStore,
  type StoredCodexManagedThread,
} from "./managed-thread-store.js";
import type { RpcRequest } from "./protocol.js";
import { tempDir, threadStartResult } from "./run-attempt-test-harness.js";
import {
  testCodexAppServerBindingStore,
  readCodexAppServerBinding,
  clearCodexAppServerBindingForThread,
} from "./session-binding.test-helpers.js";
import type { PolicyRefreshFixtures } from "./thread-lifecycle.test-fixtures.js";

/** Automatic cold admission never turns an uncertain host outcome into a new model turn. */
export function registerAutomaticColdRecoveryTests(fixtures: PolicyRefreshFixtures) {
  it.each([
    "cleared receipt",
    "legacy terminal",
    "catalog change",
    "runtime change",
    "missing binding",
    "unproved active",
    "foreign active",
  ] as const)("stops automatic cold recovery before thread selection: %s", async (scenario) => {
    const sessionFile = path.join(tempDir, "automatic-restart.jsonl");
    const agentDir = path.join(tempDir, "agent");
    const cwd = path.join(tempDir, "workspace");
    const source = threadStartResult("automatic-source");
    const requests: RpcRequest[] = [];
    const active = scenario.endsWith("active");
    const turns = [
      { id: "old-turn", status: active ? "inProgress" : "completed", error: null, items: [] },
    ];
    const managed = new Map<string, StoredCodexManagedThread>();
    const previous = testCodexAppServerBindingStore.managedThreads;
    testCodexAppServerBindingStore.managedThreads = createCodexManagedThreadStore({
      entries: async () => [...managed].map(([key, value]) => ({ key, value, createdAt: 0 })),
      registerIfAbsent: async (key, value) => {
        managed.set(key, value);
        return true;
      },
    });
    const wire = await fixtures.createLeasedLifecycleWireClient(
      agentDir,
      (request) => {
        requests.push(request);
        if (request.method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (request.method === "configRequirements/read") {
          return { requirements: null };
        }
        if (request.method === "thread/start") {
          return source;
        }
        if (request.method === "thread/read") {
          return {
            thread: { ...source.thread, turns, status: { type: active ? "active" : "notLoaded" } },
          };
        }
        if (request.method === "thread/turns/list") {
          return { data: turns, nextCursor: null };
        }
        if (request.method === "thread/resume") {
          return { ...source, thread: { ...source.thread, turns } };
        }
        if (request.method === "thread/inject_items") {
          return {};
        }
        throw new Error(`Unexpected automatic recovery request: ${request.method}`);
      },
      "websocket",
    );
    const appServer = fixtures.createThreadLifecycleAppServerOptions();
    appServer.start = { ...appServer.start, transport: "websocket", url: "ws://127.0.0.1:8123" };
    const common = {
      client: wire.client,
      params: { ...fixtures.createParams(sessionFile, cwd), agentDir },
      cwd,
      dynamicTools: [],
      appServer,
      userMcpServersEnabled: false,
      signal: new AbortController().signal,
    };
    try {
      const started = await fixtures.startOrResumeThread(common);
      const binding = {
        ...started,
        clientId: "previous-host",
        ...(scenario === "runtime change"
          ? { appServerRuntimeFingerprint: "previous-runtime" }
          : {}),
      };
      if (scenario === "cleared receipt") {
        await fixtures.writeCodexAppServerBinding(sessionFile, {
          ...binding,
          turnRecovery: { turnId: "old-turn", state: "accepted" },
        });
      }
      // The cleared case models the durable state after normal native cleanup;
      // the legacy case never had a receipt. Neither proves host task settlement.
      await fixtures.writeCodexAppServerBinding(sessionFile, binding);
      if (scenario === "missing binding") {
        await clearCodexAppServerBindingForThread(sessionFile, source.thread.id);
      }
      if (scenario === "foreign active") {
        await testCodexAppServerBindingStore.mutate(
          { kind: "conversation", bindingId: "foreign-restart-owner" },
          { kind: "set", binding: { threadId: source.thread.id, cwd } },
        );
      }
      const before = await readCodexAppServerBinding(sessionFile);
      const boundary = requests.length;
      const attempt = fixtures.startOrResumeThread({
        ...common,
        ...(scenario === "runtime change" ? { appServerRuntimeFingerprint: "new-runtime" } : {}),
        ...(scenario === "catalog change"
          ? {
              dynamicTools: [
                {
                  type: "function" as const,
                  name: "changed_tool",
                  description: "Different catalog",
                  inputSchema: { type: "object" },
                },
              ],
            }
          : {}),
        params: {
          ...common.params,
          inputProvenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
        },
      });
      await expect(attempt).rejects.toMatchObject({
        name: "AgentHarnessPreflightError",
        scope: undefined,
        userMessage: expect.stringContaining("automatic recovery"),
      });
      const recoveryRequests = requests.slice(boundary);
      expect(
        recoveryRequests.every((request) =>
          ["thread/read", "thread/turns/list"].includes(request.method),
        ),
      ).toBe(true);
      expect(await readCodexAppServerBinding(sessionFile)).toEqual(before);
      if (["runtime change", "missing binding"].includes(scenario)) {
        expect(recoveryRequests).toEqual([]);
      }
      if (["cleared receipt", "legacy terminal", "catalog change"].includes(scenario)) {
        const resumed = await fixtures.startOrResumeThread(common);
        expect(resumed.threadId).toBe(source.thread.id);
        expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(1);
      }
    } finally {
      testCodexAppServerBindingStore.managedThreads = previous;
      wire.client.close();
    }
  });
}
