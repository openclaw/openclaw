import path from "node:path";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { expect, it } from "vitest";
import {
  createCodexManagedThreadStore,
  type StoredCodexManagedThread,
} from "./managed-thread-store.js";
import { isJsonObject, type RpcRequest } from "./protocol.js";
import { tempDir, threadStartResult } from "./run-attempt-test-harness.js";
import {
  testCodexAppServerBindingStore,
  readCodexAppServerBinding,
  clearCodexAppServerBindingForThread,
} from "./session-binding.test-helpers.js";
import type { PolicyRefreshFixtures } from "./thread-lifecycle.test-fixtures.js";
import {
  attachCodexMirrorAttestation,
  fingerprintCodexMirrorSourceMessage,
} from "./transcript-mirror-attestation.js";

/** Cold admission must settle an owned orphan without dispatching its previous tools again. */
export function registerThreadOrphanRecoveryTests(fixtures: PolicyRefreshFixtures) {
  it.each([
    "accepted",
    "failed receipt",
    "completed receipt",
    "automatic continuation",
    "completed automatic continuation",
    "legacy",
    "settling",
    "foreign turn",
    "missing receipt",
    "unmanaged",
    "completed unmanaged",
    "completed other owner",
    "interruption unconfirmed",
    "authority revoked",
    "notice unconfirmed",
    "tool rotation",
    "completed tool rotation",
    "legacy tool rotation",
    "settling tool rotation",
  ] as const)("settles an accepted orphan after Gateway restart: %s", async (scenario) => {
    const completedReceipt = scenario.startsWith("completed");
    const expectsInterrupt =
      !completedReceipt && !scenario.startsWith("settling") && scenario !== "failed receipt";
    const sessionFile = path.join(tempDir, "orphan-restart.jsonl");
    const cwd = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const source = threadStartResult("orphan-source");
    const requests: RpcRequest[] = [];
    let active = false;
    let unloaded = false;
    const turns = [
      {
        id: "old-turn",
        status: "inProgress",
        error: null,
        items: [
          {
            id: "old-input",
            type: "userMessage",
            content: [{ type: "text", text: "Original task" }],
          },
        ],
      },
    ];
    let revoked = false;
    let noticeFailed = false;
    const managed = new Map<string, StoredCodexManagedThread>();
    const previous = testCodexAppServerBindingStore.managedThreads;
    testCodexAppServerBindingStore.managedThreads = createCodexManagedThreadStore({
      entries: async () => [...managed].map(([key, value]) => ({ key, value, createdAt: 0 })),
      registerIfAbsent: async (key, value) => {
        managed.set(key, value);
        return true;
      },
    });
    const respond = (request: RpcRequest) => {
      requests.push(request);
      const params = isJsonObject(request.params) ? request.params : {};
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
          thread: {
            ...source.thread,
            turns,
            status: { type: active ? "active" : unloaded ? "notLoaded" : "idle" },
          },
        };
      }
      if (request.method === "thread/turns/list") {
        if (scenario === "authority revoked") {
          revoked = true;
        }
        return { data: turns, nextCursor: null };
      }
      if (request.method === "turn/interrupt") {
        expect(params).toEqual({ threadId: source.thread.id, turnId: "old-turn" });
        if (scenario === "interruption unconfirmed") {
          throw new Error("interrupt unavailable");
        }
        active = false;
        turns[0]!.status = "interrupted";
        return {};
      }
      if (request.method === "thread/unsubscribe") {
        unloaded = true;
        wire.send({
          method: "thread/status/changed",
          params: { threadId: source.thread.id, status: { type: "notLoaded" } },
        });
        return { status: "notLoaded" };
      }
      if (request.method === "thread/resume") {
        unloaded = false;
        wire.send({
          method: "thread/status/changed",
          params: { threadId: source.thread.id, status: { type: "notLoaded" } },
        });
        return { ...source, thread: { ...source.thread, status: { type: "idle" }, turns } };
      }
      if (request.method === "thread/inject_items") {
        if (
          scenario === "notice unconfirmed" &&
          !noticeFailed &&
          JSON.stringify(params).includes("uncertain")
        ) {
          noticeFailed = true;
          throw new Error("notice response lost");
        }
        return {};
      }
      throw new Error(`Unexpected orphan recovery request: ${request.method}`);
    };
    let wire = await fixtures.createLeasedLifecycleWireClient(agentDir, respond, "websocket");
    const appServer = fixtures.createThreadLifecycleAppServerOptions();
    appServer.start = { ...appServer.start, transport: "websocket", url: "ws://127.0.0.1:8123" };
    const params = { ...fixtures.createParams(sessionFile, cwd), agentDir };
    if (scenario === "legacy" || scenario === "legacy tool rotation") {
      const scope = {
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey!,
        storePath: path.join(tempDir, "orphan-transcript", "sessions.json"),
      };
      params.sessionTarget = scope;
      await upsertSessionEntry({ ...scope, entry: { sessionId: params.sessionId, updatedAt: 1 } });
      const message = {
        role: "user" as const,
        content: "Original task",
        timestamp: 1,
        __openclaw: {
          mirrorIdentity: "old-turn:prompt",
          upstreamUserText: "Original task",
          mirrorOrigin: "codex-app-server",
          mirrorSourceFingerprint: "",
        },
      };
      await appendSessionTranscriptMessageByIdentity({
        ...scope,
        message: attachCodexMirrorAttestation(
          message,
          fingerprintCodexMirrorSourceMessage(message),
        ),
      });
    }
    const common = {
      client: wire.client,
      assertCurrent: () => {
        if (revoked) {
          throw new Error("recovery host authority revoked");
        }
      },
      params,
      cwd,
      dynamicTools: [],
      appServer,
      userMcpServersEnabled: false,
      signal: new AbortController().signal,
    };
    try {
      const started = await fixtures.startOrResumeThread(common);
      await fixtures.writeCodexAppServerBinding(
        sessionFile,
        Object.assign({}, started, {
          clientId: "client-before-gateway-restart",
          ...(["legacy", "legacy tool rotation", "missing receipt"].includes(scenario)
            ? {}
            : {
                turnRecovery: {
                  turnId: "old-turn",
                  state: scenario.startsWith("settling") ? "settling" : "accepted",
                },
              }),
        }),
      );
      active = expectsInterrupt;
      if (completedReceipt) {
        turns[0]!.status = "completed";
      }
      if (scenario === "failed receipt") {
        turns[0]!.status = "failed";
      }
      if (scenario.startsWith("settling")) {
        turns[0]!.status = "interrupted";
      }
      if (scenario.includes("tool rotation")) {
        await expect(
          fixtures.startOrResumeThread({
            ...common,
            dynamicTools: [
              {
                type: "function",
                name: "changed_tool",
                description: "Changed immutable catalog",
                inputSchema: { type: "object" },
              },
            ],
          }),
        ).rejects.toThrow(/previous Codex task/);
        expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(1);
        expect(
          requests.some((request) => ["turn/start", "thread/fork"].includes(request.method)),
        ).toBe(false);
        expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe(source.thread.id);
        expect((await readCodexAppServerBinding(sessionFile))?.turnRecovery?.state).toBe(
          "settling",
        );
      }
      if (scenario === "foreign turn") {
        turns[0]!.id = "external-successor";
      }
      if (scenario.endsWith("unmanaged")) {
        testCodexAppServerBindingStore.managedThreads = undefined;
      }
      if (scenario === "completed other owner") {
        await testCodexAppServerBindingStore.mutate(
          { kind: "conversation", bindingId: "other-conversation" },
          { kind: "set", binding: { threadId: source.thread.id, cwd } },
        );
      }
      if (
        [
          "foreign turn",
          "missing receipt",
          "unmanaged",
          "completed unmanaged",
          "completed other owner",
          "interruption unconfirmed",
          "authority revoked",
        ].includes(scenario)
      ) {
        await expect(fixtures.startOrResumeThread(common)).rejects.toThrow(
          scenario === "authority revoked" ? /authority revoked/ : /previous Codex task/,
        );
        expect(requests.filter((request) => request.method === "turn/interrupt")).toHaveLength(
          scenario === "interruption unconfirmed" ? 1 : 0,
        );
        expect(
          requests.some((request) =>
            ["thread/resume", "thread/fork", "thread/inject_items"].includes(request.method),
          ),
        ).toBe(false);
        expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe(source.thread.id);
        return;
      }
      if (scenario.endsWith("automatic continuation")) {
        await expect(
          fixtures.startOrResumeThread({
            ...common,
            params: {
              ...common.params,
              inputProvenance: {
                kind: "internal_system",
                sourceTool: "main_session_restart_recovery",
              },
            },
          }),
        ).rejects.toThrow(/automatic recovery/);
        expect(requests.filter((request) => request.method === "turn/interrupt")).toHaveLength(
          expectsInterrupt ? 1 : 0,
        );
        expect(
          requests.some((request) => ["turn/start", "thread/resume"].includes(request.method)),
        ).toBe(false);
        expect((await readCodexAppServerBinding(sessionFile))?.turnRecovery?.state).toBe(
          "settling",
        );
      }
      if (scenario === "notice unconfirmed") {
        await expect(fixtures.startOrResumeThread(common)).rejects.toThrow(/notice response lost/);
        expect((await readCodexAppServerBinding(sessionFile))?.turnRecovery?.state).toBe(
          "settling",
        );
        wire.client.close();
        wire = await fixtures.createLeasedLifecycleWireClient(agentDir, respond, "websocket");
        common.client = wire.client;
      }
      const resumed = await fixtures.startOrResumeThread(common);
      expect(resumed.threadId).toBe(source.thread.id);
      expect(requests.filter((request) => request.method === "turn/interrupt")).toHaveLength(
        expectsInterrupt ? 1 : 0,
      );
      expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(1);
      expect(requests.some((request) => request.method === "turn/start")).toBe(false);
      expect(
        JSON.stringify(requests.filter((request) => request.method === "thread/inject_items")),
      ).toContain("uncertain");
      expect(await readCodexAppServerBinding(sessionFile)).not.toHaveProperty("turnRecovery");
    } finally {
      testCodexAppServerBindingStore.managedThreads = previous;
      wire.client.close();
    }
  });

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
