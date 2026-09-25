import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { retainCodexAppServerLiveThread } from "./client-runtime.js";
import { CodexAppServerRpcError } from "./client.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import {
  getCodexInferenceThread,
  getCodexInferenceThreadQualification,
  ownCodexInferenceClient,
} from "./inference-routing.js";
import { isJsonObject } from "./protocol.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createParams,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import {
  createAppServerOptions,
  createLeasedCodexLifecycleHarness,
  startOrResumeThread,
} from "./thread-lifecycle.test-fixtures.js";
setupRunAttemptTestHooks();
describe("Codex native configuration lifecycle", () => {
  it.each([false, true])(
    "validates every operator parent provider in final native config (overridden: %s)",
    async (overridden) => {
      const sessionFile = path.join(tempDir, "all-provider-routes.jsonl");
      const workspaceDir = path.join(tempDir, "all-provider-workspace");
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond: async (method) => {
          if (method === "config/read") {
            return {
              config: {
                model_providers: {
                  restored: { name: "Stored provider", base_url: "https://restored.example/v1" },
                },
              },
              origins: {},
              layers: [],
            };
          }
          if (method === "configRequirements/read") {
            return { requirements: null };
          }
          if (method === "account/read") {
            return { account: { type: "apiKey" } };
          }
          if (method === "thread/start") {
            return threadStartResult("parent");
          }
          throw new Error(`unexpected method: ${method}`);
        },
      });
      ownCodexInferenceClient(fixture.client);
      const params = createParams(sessionFile, workspaceDir);
      const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params, {
        profileId: "operator-parent",
        scopes: ["operator.write"],
        assertCurrent: () => {},
      });
      try {
        const pending = startOrResumeThread({
          client: fixture.client,
          params,
          cwd: workspaceDir,
          dynamicTools: [],
          appServer: createAppServerOptions(),
          userMcpServersEnabled: false,
          buildFinalConfigPatch: async () => ({
            configPatch: overridden
              ? { "model_providers.restored.base_url": "https://bypass.example/v1" }
              : undefined,
          }),
        });
        if (overridden) {
          await expect(pending).rejects.toThrow("inference route was overridden");
          expect(
            fixture.writes.some((line) => {
              const frame: unknown = JSON.parse(line);
              return isJsonObject(frame) && frame.method === "thread/start";
            }),
          ).toBe(false);
        } else {
          const binding = await pending;
          const qualification = getCodexInferenceThreadQualification(
            fixture.client,
            binding.threadId,
          );
          expect(qualification?.hasProvider("openai")).toBe(true);
          expect(qualification?.hasProvider("restored")).toBe(true);
        }
      } finally {
        closeHost();
        fixture.client.close();
      }
    },
  );

  it.each(["rotation", "missing resume"] as const)(
    "routes the final native provider after %s without reusing the injected URL as upstream",
    async (recovery) => {
      const sessionFile = path.join(tempDir, "inference-selection.jsonl");
      const workspaceDir = path.join(tempDir, "inference-selection-workspace");
      registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        persistedThreads: ["old-thread"],
        respond: async (method) => {
          if (method === "config/read") {
            return { config: {}, origins: {}, layers: [] };
          }
          if (method === "configRequirements/read") {
            return { requirements: null };
          }
          if (method === "account/read") {
            return { account: { type: "apiKey" } };
          }
          if (method === "thread/resume") {
            throw new CodexAppServerRpcError(
              { code: -32_600, message: "thread not loaded: old-thread" },
              method,
            );
          }
          if (method === "thread/start") {
            return threadStartResult("new-thread");
          }
          if (method === "thread/inject_items") {
            return {};
          }
          throw new Error(`unexpected method: ${method}`);
        },
      });
      ownCodexInferenceClient(fixture.client);
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "old-thread",
        clientId: fixture.client.getInstanceId(),
        cwd: workspaceDir,
        model: "gpt-5.4-codex",
        modelProvider: recovery === "rotation" ? "retired-provider" : "openai",
        dynamicToolsFingerprint: "[]",
        webSearchThreadConfigFingerprint: JSON.stringify({
          "features.standalone_web_search": false,
          web_search: "disabled",
        }),
        ...(recovery === "rotation" ? { nativeSkillIsolationFingerprint: "retired" } : {}),
      });
      const params = createParams(sessionFile, workspaceDir);
      const config = { openai_base_url: "https://api.openai.com/v1" };
      try {
        const binding = await startOrResumeThread({
          client: fixture.client,
          params,
          cwd: workspaceDir,
          dynamicTools: [],
          appServer: createAppServerOptions(),
          userMcpServersEnabled: false,
          config,
        });
        const route = getCodexInferenceThread(fixture.client, binding.threadId);
        expect(route?.upstream).toBe("https://api.openai.com/v1");
        const start = fixture.request.mock.calls.find(([method]) => method === "thread/start")?.[1];
        expect(start).toMatchObject({ config: { openai_base_url: route?.baseUrl } });
        if (recovery === "missing resume") {
          expect(start).toHaveProperty("modelProvider", "openai");
        } else {
          expect(start).not.toHaveProperty("modelProvider");
        }
        expect(config).toEqual({ openai_base_url: "https://api.openai.com/v1" });
        expect(
          fixture.request.mock.calls.filter(([method]) => method === "thread/resume"),
        ).toHaveLength(recovery === "missing resume" ? 1 : 0);
      } finally {
        fixture.client.close();
      }
    },
  );

  it.each(["missing issuer", "policy introduced during preparation"] as const)(
    "refuses an unowned route before native dispatch when %s",
    async (restriction) => {
      const sessionFile = path.join(tempDir, "unowned-inference.jsonl");
      const workspaceDir = path.join(tempDir, "unowned-inference-workspace");
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond: async (method) => {
          if (method === "config/read") {
            return { config: {}, origins: {}, layers: [] };
          }
          if (method === "configRequirements/read") {
            return { requirements: null };
          }
          if (method === "thread/start") {
            return threadStartResult("unexpected-thread");
          }
          throw new Error(`unexpected method: ${method}`);
        },
      });
      const params = createParams(sessionFile, workspaceDir);
      let modelPolicyRequired = false;
      const closeHost =
        restriction === "missing issuer"
          ? undefined
          : await bindProductionHarnessHostCapabilitiesForTest(params, {
              profileId: "restricted-caller",
              scopes: ["operator.write"],
              assertCurrent: () => {},
              get modelPolicy() {
                return modelPolicyRequired ? { models: [], allows: () => false } : undefined;
              },
            });
      if (restriction === "missing issuer") {
        params.hostCapabilities = createCodexTestHostCapabilities({
          retainSourceAuthority: undefined,
        });
      }
      try {
        await expect(
          startOrResumeThread({
            client: fixture.client,
            params,
            cwd: workspaceDir,
            dynamicTools: [],
            appServer: createAppServerOptions(),
            userMcpServersEnabled: false,
            buildFinalConfigPatch: async () => {
              await Promise.resolve();
              modelPolicyRequired = true;
              return {};
            },
          }),
        ).rejects.toThrow("cannot enforce your operator role's model policy");
        expect(
          fixture.request.mock.calls.some(([method]) =>
            ["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(method),
          ),
        ).toBe(false);
      } finally {
        closeHost?.();
      }
    },
  );

  it.each([
    {
      homeScope: "user" as const,
      provider: "openai",
      requestProvider: undefined,
      nativeProvider: "native-proxy",
    },
    {
      homeScope: "agent" as const,
      provider: "openai",
      requestProvider: "openai",
      nativeProvider: "openai",
    },
    {
      homeScope: "user" as const,
      provider: "other-provider",
      requestProvider: "other-provider",
      nativeProvider: "other-provider",
    },
  ])(
    "keeps provider ownership through start and resume ($homeScope, $provider)",
    async ({ homeScope, provider, requestProvider, nativeProvider }) => {
      const sessionFile = path.join(tempDir, "native-provider-session.jsonl");
      const workspaceDir = path.join(tempDir, "native-provider-workspace");
      registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
      const native = {
        ...threadStartResult("native-provider-thread", { cwd: workspaceDir }),
        modelProvider: nativeProvider,
      };
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond: async (method) => {
          if (method === "config/read") {
            return { config: { model_provider: nativeProvider }, origins: {}, layers: [] };
          }
          if (method === "configRequirements/read") {
            return { requirements: null };
          }
          if (method === "thread/start" || method === "thread/resume") {
            return native;
          }
          throw new Error(`unexpected method: ${method}`);
        },
      });
      const params = createParams(sessionFile, workspaceDir);
      params.provider = provider;
      params.config = undefined;
      const appServer = createAppServerOptions();
      const common = {
        client: fixture.client,
        params,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: {
          ...appServer,
          start: {
            ...appServer.start,
            transport: "unix" as const,
            homeScope,
            url: "unix:///tmp/synthetic-codex.sock",
          },
        },
        userMcpServersEnabled: false,
      };
      await startOrResumeThread(common);
      fixture.seed(native, { loaded: false, subscribed: false });
      await startOrResumeThread(common);
      for (const method of ["thread/start", "thread/resume"]) {
        const call = fixture.request.mock.calls.find(([name]) => name === method);
        expect(call, method).toBeDefined();
        if (requestProvider === undefined) {
          expect(call?.[1]).not.toHaveProperty("modelProvider");
        } else {
          expect(call?.[1]).toHaveProperty("modelProvider", requestProvider);
        }
        expect(call?.[1]).toHaveProperty("model", params.modelId);
      }
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
        modelProvider: nativeProvider,
      });
    },
  );

  it.each([
    { nativeModel: false, changeModel: false },
    { nativeModel: true, changeModel: true },
    { nativeModel: true, changeModel: false },
  ])(
    "rebinds before warm reuse (native: $nativeModel, changed model: $changeModel)",
    async ({ nativeModel, changeModel }) => {
      const sessionFile = path.join(tempDir, "replacement-client-session.jsonl");
      const workspaceDir = path.join(tempDir, "replacement-client-workspace");
      registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
      await writeCodexAppServerBinding(sessionFile, {
        webSearchThreadConfigFingerprint: JSON.stringify({
          "features.standalone_web_search": false,
          web_search: "cached",
        }),
        threadId: "thread-reused",
        clientId: "client-before-restart",
        ...(nativeModel
          ? {
              preserveNativeModel: true,
              model: threadStartResult().model,
              modelProvider: threadStartResult().modelProvider,
            }
          : {}),
        cwd: workspaceDir,
        dynamicToolsFingerprint: "[]",
      });
      const respond = vi.fn(async (method: string) => {
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/resume") {
          return threadStartResult("thread-reused");
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond,
        persistedThreads: ["thread-reused"],
      });
      const { client, request } = fixture;
      const params = createParams(sessionFile, workspaceDir);
      params.disableTools = false;
      params.config = undefined;
      const common = {
        client,
        params,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: {
          ...createAppServerOptions(),
          connectionClass: "local-loopback" as const,
          remoteAppsSubstrate: "preconfigured" as const,
        },
        userMcpServersEnabled: false,
      };

      const resumed = await startOrResumeThread(common);

      expect(resumed.clientId).toBe(client.getInstanceId());
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
        threadId: "thread-reused",
        clientId: client.getInstanceId(),
      });
      await retainCodexAppServerLiveThread(
        client,
        resumed.threadId,
        undefined,
        resumed.liveThreadConfigFingerprint,
      );
      if (changeModel) {
        const native = threadStartResult("thread-reused");
        fixture.seed(
          { ...native, thread: { ...native.thread, model: "changed-native-model" } },
          { loaded: true, subscribed: true },
        );
      }
      const warm = await startOrResumeThread(common);
      if (changeModel) {
        expect(warm.model).toBe("changed-native-model");
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
          model: "changed-native-model",
        });
      }
      expect(warm).toMatchObject({
        threadId: "thread-reused",
        clientId: client.getInstanceId(),
      });
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "config/read",
        "configRequirements/read",
        "thread/read",
        "thread/resume",
        "thread/inject_items",
        "config/read",
        "configRequirements/read",
        ...(nativeModel ? ["thread/read"] : []),
      ]);
      if (nativeModel && !changeModel) {
        await retainCodexAppServerLiveThread(
          client,
          warm.threadId,
          warm.liveThreadOwnership?.release,
          warm.liveThreadConfigFingerprint,
        );
        const native = threadStartResult("thread-reused");
        fixture.seed(
          { ...native, thread: { ...native.thread, status: { type: "active", activeFlags: [] } } },
          { loaded: true, subscribed: true },
        );
        const resumeCount = request.mock.calls.filter(
          ([method]) => method === "thread/resume",
        ).length;
        await expect(startOrResumeThread(common)).rejects.toThrow("active");
        expect(request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(
          resumeCount,
        );
        expect(
          request.mock.calls.some(
            ([method]) => method === "turn/interrupt" || method === "thread/archive",
          ),
        ).toBe(false);
        expect(
          request.mock.calls.filter(([method]) => method === "thread/unsubscribe"),
        ).toHaveLength(0);
        fixture.seed(native, { loaded: true, subscribed: true });
        await expect(startOrResumeThread(common)).resolves.toMatchObject({
          threadId: "thread-reused",
        });
        expect(request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(
          resumeCount,
        );
        expect(
          request.mock.calls.filter(([method]) => method === "thread/unsubscribe"),
        ).toHaveLength(0);
      }
    },
  );
});
