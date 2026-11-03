import path from "node:path";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { expect, it } from "vitest";
import { retainCodexAppServerLiveThread } from "./client-runtime.js";
import { fingerprintCodexPolicy } from "./config-policy-json.js";
import {
  createCodexManagedThreadStore,
  type StoredCodexManagedThread,
} from "./managed-thread-store.js";
import { buildCodexAppServerRuntimeFingerprint } from "./plugin-app-cache-key.js";
import {
  buildPluginAppPolicyContext,
  fingerprintCodexPluginThreadConfig,
  type CodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import { isJsonObject, type RpcRequest } from "./protocol.js";
import { tempDir, threadStartResult } from "./run-attempt-test-harness.js";
import {
  testCodexAppServerBindingStore,
  readCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { registerAutomaticColdRecoveryTests } from "./thread-lifecycle-automatic-recovery.test-support.js";
import type { PolicyRefreshFixtures } from "./thread-lifecycle.test-fixtures.js";
import {
  attachCodexMirrorAttestation,
  fingerprintCodexMirrorSourceMessage,
} from "./transcript-mirror-attestation.js";

/** Cold admission must settle an owned orphan without dispatching its previous tools again. */
export function registerThreadOrphanRecoveryTests(fixtures: PolicyRefreshFixtures) {
  it.each([
    "accepted",
    "completed executor upgrade",
    "interrupted executor upgrade",
    "interrupted executor upgrade with additive plugin apps",
    "completed executor upgrade with additive plugin apps",
    "active executor upgrade with additive plugin apps",
    "interrupted executor upgrade with additive plugin apps and removal",
    "interrupted executor upgrade with additive plugin apps and permission change",
    "interrupted executor upgrade with additive plugin apps and approval change",
    "interrupted executor upgrade with additive plugin apps and read-only change",
    "interrupted executor upgrade with additive plugin apps and default change",
    "interrupted executor upgrade with additive plugin apps and schema change",
    "interrupted executor upgrade with additive plugin apps and authority revoked",
    "interrupted executor upgrade with additive plugin apps and scoped change",
    "interrupted executor upgrade with additive plugin apps and unload unconfirmed",
    "completed executor upgrade with changed credential",
    "completed executor upgrade with no credential",
    "completed executor upgrade reversed",
    "completed executor upgrade with unseen later turn",
    "completed executor upgrade from system",
    "active executor upgrade",
    "completed executor upgrade with handoff",
    "completed executor upgrade with different endpoint",
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
    "plugin input refresh",
    "idle plugin input refresh",
    "warm plugin input refresh",
    "plugin input refresh notice unconfirmed",
    "plugin policy change",
  ] as const)("settles an accepted orphan after Gateway restart: %s", async (scenario) => {
    const warm = scenario === "warm plugin input refresh";
    const idle = scenario === "idle plugin input refresh" || warm;
    const pluginRefresh = scenario.includes("plugin");
    const additiveApps = scenario.includes("additive plugin apps");
    const noticeUnconfirmed =
      scenario === "notice unconfirmed" || scenario === "plugin input refresh notice unconfirmed";
    const completedReceipt = scenario.startsWith("completed") || idle;
    const expectsInterrupt =
      !completedReceipt &&
      !scenario.startsWith("interrupted executor upgrade") &&
      !scenario.startsWith("settling") &&
      scenario !== "failed receipt";
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
        return requests.filter(({ method }) => method === "thread/start").length > 1
          ? { ...source, thread: { ...source.thread, id: "unexpected-replacement" } }
          : source;
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
        if (scenario.endsWith("authority revoked")) {
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
        if (scenario.endsWith("unload unconfirmed")) {
          return { status: "unsubscribed" };
        }
        unloaded = true;
        wire.send({
          method: "thread/status/changed",
          params: { threadId: source.thread.id, status: { type: "notLoaded" } },
        });
        return { status: "notLoaded" };
      }
      if (request.method === "thread/resume") {
        unloaded = false;
        if (!scenario.endsWith("unload unconfirmed")) {
          wire.send({
            method: "thread/status/changed",
            params: { threadId: source.thread.id, status: { type: "notLoaded" } },
          });
        }
        return { ...source, thread: { ...source.thread, status: { type: "idle" }, turns } };
      }
      if (request.method === "app/installed") {
        return {
          apps: Object.keys(pluginConfig.policyContext.apps).map((id) => ({
            id,
            enabled: true,
            callable: true,
          })),
        };
      }
      if (request.method === "thread/inject_items") {
        if (noticeUnconfirmed && !noticeFailed && JSON.stringify(params).includes("uncertain")) {
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
    const upgraded = scenario.includes("executor upgrade");
    function runtimeFingerprint(version: string) {
      return buildCodexAppServerRuntimeFingerprint({
        appServer,
        runtimeIdentity: {
          serverVersion: version,
          userAgent: `OpenClaw/${version} (Linux; x86_64)`,
          codexHome: "/home/dev-user/.codex",
          platformFamily: "unix",
          platformOs: "linux",
        },
      });
    }
    if (upgraded) {
      appServer.connectionClass = "remote";
      if (!scenario.endsWith("no credential")) {
        appServer.start.authToken = "test-stable-token";
      }
      params.trigger = "user";
      params.inputProvenance = { kind: "external_user" };
    }
    const existingAppPolicy = {
      configKey: "existing@openai-curated-remote",
      marketplaceName: "openai-curated-remote" as const,
      pluginName: "existing",
      allowDestructiveActions: true,
      allowOpenWorld: true,
      destructiveApprovalMode: "ask" as const,
      mcpServerNames: [],
    };
    const policyContext = buildPluginAppPolicyContext(
      additiveApps ? { "existing-app": existingAppPolicy } : {},
      additiveApps ? { [existingAppPolicy.configKey]: ["existing-app"] } : {},
    );
    const existingAppConfig = {
      enabled: true,
      destructive_enabled: true,
      open_world_enabled: true,
      default_tools_approval_mode: "auto",
      approvals_reviewer: "user",
      tools: { existing_tool: { approval_mode: "auto" } },
    };
    const configPatch = {
      apps: {
        _default: { enabled: false },
        ...(additiveApps ? { "existing-app": existingAppConfig } : {}),
      },
    };
    // Persisted v2 config identity includes the admission input version. A new
    // validator can require rebuilding even when its effective grants stay equal.
    let pluginConfig: CodexPluginThreadConfig = {
      enabled: true,
      inputFingerprint: "admission-v15",
      configPatch,
      policyContext,
      ...(additiveApps ? { provisionalAppIds: ["existing-app"] } : {}),
      fingerprint: fingerprintCodexPolicy({
        version: 2,
        inputFingerprint: "admission-v15",
        configPatch,
        policyContext,
      }),
      diagnostics: [],
    };
    const pluginProvider = {
      enabled: true,
      inputFingerprint: pluginConfig.inputFingerprint,
      build: async (options?: { threadId?: string }) => {
        if (
          options?.threadId &&
          pluginConfig.inputFingerprint === "admission-v16" &&
          scenario.endsWith("scoped change")
        ) {
          const changed = {
            ...pluginConfig,
            configPatch: { apps: { _default: { enabled: false } } },
          };
          return { ...changed, fingerprint: fingerprintCodexPluginThreadConfig(changed) };
        }
        return pluginConfig;
      },
    };
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
      appServerRuntimeFingerprint: upgraded ? runtimeFingerprint("0.153.4") : undefined,
      cwd,
      dynamicTools: [],
      appServer,
      userMcpServersEnabled: false,
      signal: new AbortController().signal,
      ...(pluginRefresh ? { pluginThreadConfig: pluginProvider } : {}),
    };
    try {
      const started = await fixtures.startOrResumeThread(common);
      await fixtures.writeCodexAppServerBinding(
        sessionFile,
        Object.assign({}, started, {
          ...(scenario.endsWith("with handoff") ? { dynamicToolHandoff: { retained: true } } : {}),
          clientId: warm ? started.clientId : "client-before-gateway-restart",
          ...(idle || ["legacy", "legacy tool rotation", "missing receipt"].includes(scenario)
            ? {}
            : {
                turnRecovery: {
                  turnId: "old-turn",
                  state: scenario.startsWith("settling") ? "settling" : "accepted",
                },
              }),
        }),
      );
      if (warm) {
        await retainCodexAppServerLiveThread(
          wire.client,
          source.thread.id,
          undefined,
          started.liveThreadConfigFingerprint,
        );
      }
      if (upgraded) {
        if (scenario.endsWith("different endpoint")) {
          appServer.start = { ...appServer.start, url: "ws://another-claw:8123" };
        }
        if (scenario.endsWith("changed credential")) {
          appServer.start.authToken = "replaced-test-token";
        }
        if (scenario.endsWith("from system")) {
          params.inputProvenance = { kind: "internal_system" };
        }
        if (scenario.endsWith("unseen later turn")) {
          turns.push({ ...turns[0]!, id: "later", status: "completed" });
        }
        common.appServerRuntimeFingerprint = runtimeFingerprint(
          scenario.endsWith("reversed") ? "0.150.0" : "0.163.0",
        );
      }
      active = expectsInterrupt;
      if (completedReceipt) {
        turns[0]!.status = "completed";
      }
      if (scenario.startsWith("interrupted executor upgrade")) {
        unloaded = !scenario.endsWith("unload unconfirmed");
        turns[0]!.status = "interrupted";
      }
      if (pluginRefresh) {
        let nextPatch: CodexPluginThreadConfig["configPatch"] =
          scenario === "plugin policy change"
            ? { apps: { _default: { enabled: true } } }
            : configPatch;
        let nextPolicyContext = policyContext;
        if (additiveApps) {
          const addedAppPolicy = {
            ...existingAppPolicy,
            configKey: "added@openai-curated-remote",
            pluginName: "added",
          };
          const existingPolicy = { ...existingAppPolicy };
          const existingConfig = { ...existingAppConfig };
          if (scenario.endsWith("permission change")) {
            existingPolicy.allowDestructiveActions = false;
            existingConfig.destructive_enabled = false;
          }
          if (scenario.endsWith("approval change")) {
            existingConfig.tools = { existing_tool: { approval_mode: "prompt" } };
          }
          nextPolicyContext = buildPluginAppPolicyContext(
            {
              ...(scenario.endsWith("removal")
                ? {}
                : {
                    "existing-app": {
                      ...existingPolicy,
                      ...(scenario.endsWith("read-only change") ? { readOnlyTools: {} } : {}),
                    },
                  }),
              "added-app": addedAppPolicy,
            },
            {
              [existingAppPolicy.configKey]: ["existing-app"],
              [addedAppPolicy.configKey]: ["added-app"],
            },
          );
          nextPatch = {
            ...(scenario.endsWith("schema change") ? { new_policy_field: true } : {}),
            apps: {
              _default: { enabled: scenario.endsWith("default change") },
              "existing-app": scenario.endsWith("removal") ? { enabled: false } : existingConfig,
              "added-app": existingAppConfig,
            },
          };
        }
        pluginConfig = {
          ...pluginConfig,
          inputFingerprint: "admission-v16",
          configPatch: nextPatch,
          policyContext: nextPolicyContext,
          ...(additiveApps ? { provisionalAppIds: ["existing-app", "added-app"] } : {}),
          fingerprint: fingerprintCodexPolicy({
            version: 2,
            inputFingerprint: "admission-v16",
            configPatch: nextPatch,
            policyContext: nextPolicyContext,
          }),
        };
        pluginProvider.inputFingerprint = pluginConfig.inputFingerprint;
        if (
          scenario === "plugin policy change" ||
          (additiveApps &&
            [
              "removal",
              "permission change",
              "approval change",
              "read-only change",
              "default change",
              "schema change",
            ].some((change) => scenario.endsWith(change)))
        ) {
          await expect(fixtures.startOrResumeThread(common)).rejects.toThrow(/previous Codex task/);
          expect(requests.filter(({ method }) => method === "thread/start")).toHaveLength(1);
          expect(requests.some(({ method }) => method === "thread/resume")).toBe(false);
          expect(requests.some(({ method }) => method === "turn/start")).toBe(false);
          if (additiveApps) {
            expect(requests.some(({ method }) => method === "thread/read")).toBe(false);
          }
          expect((await readCodexAppServerBinding(sessionFile))?.pluginAppsInputFingerprint).toBe(
            "admission-v15",
          );
          return;
        }
      }
      if (scenario === "failed receipt") {
        turns[0]!.status = "failed";
      }
      if (scenario.startsWith("settling")) {
        turns[0]!.status = "interrupted";
      }
      if (scenario.includes("tool rotation")) {
        const changedCatalog = {
          ...common,
          params: { ...common.params, trigger: "user" as const },
          dynamicTools: [
            {
              type: "function" as const,
              name: "changed_tool",
              description: "Changed immutable catalog",
              inputSchema: { type: "object" },
            },
          ],
        };
        await expect(fixtures.startOrResumeThread(changedCatalog)).rejects.toMatchObject({
          name: "CodexAdoptedThreadActiveError",
          message: expect.stringContaining("dynamic tool catalog"),
          userMessage: expect.stringContaining("/new"),
        });
        if (scenario === "settling tool rotation") {
          const beforeHeartbeat = requests.length;
          await expect(
            fixtures.startOrResumeThread({
              ...changedCatalog,
              params: { ...common.params, trigger: "heartbeat" },
            }),
          ).rejects.toMatchObject({
            name: "CodexAdoptedThreadActiveError",
            userMessage: undefined,
          });
          expect(
            requests
              .slice(beforeHeartbeat)
              .filter((request) => /^(thread|turn)\//.test(request.method))
              .map((request) => request.method),
          ).toEqual(["thread/read", "thread/turns/list"]);
        }
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
          "active executor upgrade",
          "active executor upgrade with additive plugin apps",
          "interrupted executor upgrade with additive plugin apps and authority revoked",
          "completed executor upgrade with changed credential",
          "completed executor upgrade with no credential",
          "completed executor upgrade reversed",
          "completed executor upgrade with unseen later turn",
          "completed executor upgrade from system",
          "completed executor upgrade with handoff",
          "completed executor upgrade with different endpoint",
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
          scenario.endsWith("authority revoked") ? /authority revoked/ : /previous Codex task/,
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
      if (scenario.endsWith("scoped change") || scenario.endsWith("unload unconfirmed")) {
        await expect(fixtures.startOrResumeThread(common)).rejects.toThrow(
          scenario.endsWith("scoped change") ? /previous Codex task/ : /unloading/,
        );
        expect(requests.filter(({ method }) => method === "thread/start")).toHaveLength(1);
        expect(requests.some(({ method }) => method === "turn/start")).toBe(false);
        expect(requests.some(({ method }) => method === "thread/inject_items")).toBe(false);
        expect((await readCodexAppServerBinding(sessionFile))?.pluginAppsInputFingerprint).toBe(
          "admission-v15",
        );
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
      if (noticeUnconfirmed) {
        await expect(fixtures.startOrResumeThread(common)).rejects.toThrow(/notice response lost/);
        expect((await readCodexAppServerBinding(sessionFile))?.turnRecovery?.state).toBe(
          "settling",
        );
        if (pluginRefresh) {
          expect((await readCodexAppServerBinding(sessionFile))?.pluginAppsInputFingerprint).toBe(
            "admission-v15",
          );
        }
        wire.client.close();
        wire = await fixtures.createLeasedLifecycleWireClient(agentDir, respond, "websocket");
        common.client = wire.client;
      }
      const resumed = await fixtures.startOrResumeThread(common);
      expect(resumed.threadId).toBe(source.thread.id);
      if (upgraded) {
        expect((await readCodexAppServerBinding(sessionFile))?.appServerRuntimeFingerprint).toBe(
          common.appServerRuntimeFingerprint,
        );
      }
      expect(requests.filter((request) => request.method === "turn/interrupt")).toHaveLength(
        expectsInterrupt ? 1 : 0,
      );
      expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(1);
      expect(requests.some((request) => request.method === "turn/start")).toBe(false);
      if (!idle) {
        expect(
          JSON.stringify(requests.filter((request) => request.method === "thread/inject_items")),
        ).toContain("uncertain");
      }
      if (pluginRefresh) {
        expect((await readCodexAppServerBinding(sessionFile))?.pluginAppsInputFingerprint).toBe(
          "admission-v16",
        );
      }
      if (additiveApps) {
        expect((await readCodexAppServerBinding(sessionFile))?.pluginAppPolicyContext).toEqual(
          pluginConfig.policyContext,
        );
        const resume = requests.find(({ method }) => method === "thread/resume");
        expect(resume?.params).toMatchObject({
          threadId: source.thread.id,
          config: { apps: { "existing-app": existingAppConfig, "added-app": existingAppConfig } },
        });
        expect(requests.findIndex(({ method }) => method === "thread/turns/list")).toBeLessThan(
          requests.findIndex(({ method }) => method === "thread/resume"),
        );
      }
      expect(await readCodexAppServerBinding(sessionFile)).not.toHaveProperty("turnRecovery");
      if (scenario === "interrupted executor upgrade") {
        const notices = () =>
          requests.filter(
            (request) =>
              request.method === "thread/inject_items" &&
              JSON.stringify(request.params).includes("uncertain"),
          );
        expect(notices()).toHaveLength(1);
        expect((await fixtures.startOrResumeThread(common)).threadId).toBe(source.thread.id);
        expect(notices()).toHaveLength(1);
        expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(1);
        expect(requests.some((request) => request.method === "turn/interrupt")).toBe(false);
      }
    } finally {
      testCodexAppServerBindingStore.managedThreads = previous;
      wire.client.close();
    }
  });

  registerAutomaticColdRecoveryTests(fixtures);
}
