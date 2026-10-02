import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { retainCodexAppServerLiveThread } from "./client-runtime.js";
import { CodexAppServerRpcError } from "./client.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import {
  getCodexInferenceThread,
  getCodexInferenceThreadQualification,
  ownCodexInferenceClient,
} from "./inference-routing.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
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

let sessionFile: string;
let workspaceDir: string;
let params: ReturnType<typeof createParams>;
beforeEach(() => {
  sessionFile = path.join(tempDir, "session.jsonl");
  workspaceDir = path.join(tempDir, "workspace");
  params = createParams(sessionFile, workspaceDir);
});

function lifecycleParams(client: Parameters<typeof startOrResumeThread>[0]["client"]) {
  return {
    client,
    params,
    cwd: workspaceDir,
    dynamicTools: [],
    appServer: createAppServerOptions(),
    userMcpServersEnabled: false,
  };
}

function readNativeConfig(method: string, config: JsonObject = {}) {
  if (method === "config/read") {
    return { config, origins: {}, layers: [] };
  }
  if (method === "configRequirements/read") {
    return { requirements: null };
  }
  throw new Error(`unexpected method: ${method}`);
}

describe("Codex native configuration lifecycle", () => {
  it.each([false, true])(
    "validates every operator parent provider in final native config (overridden: %s)",
    async (overridden) => {
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond: async (method) => {
          if (method === "account/read") {
            return { account: { type: "apiKey" } };
          }
          if (method === "thread/start") {
            return threadStartResult("parent");
          }
          return readNativeConfig(method, {
            model_providers: {
              restored: { name: "Stored provider", base_url: "https://restored.example/v1" },
            },
          });
        },
      });
      ownCodexInferenceClient(fixture.client);
      const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params, {
        profileId: "operator-parent",
        scopes: ["operator.write"],
        assertCurrent: () => {},
      });
      try {
        const pending = startOrResumeThread({
          ...lifecycleParams(fixture.client),
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
      registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        persistedThreads: ["old-thread"],
        respond: async (method) => {
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
          return readNativeConfig(method);
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
      const config = { openai_base_url: "https://api.openai.com/v1" };
      try {
        const binding = await startOrResumeThread({
          ...lifecycleParams(fixture.client),
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
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond: async (method) => {
          if (method === "thread/start") {
            return threadStartResult("unexpected-thread");
          }
          return readNativeConfig(method);
        },
      });
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
            ...lifecycleParams(fixture.client),
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

  it("preserves the native user-home provider through start and resume", async () => {
    const nativeProvider = "native-proxy";
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    const native = {
      ...threadStartResult("native-provider-thread", { cwd: workspaceDir }),
      modelProvider: nativeProvider,
    };
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond: async (method) => {
        if (method === "thread/start" || method === "thread/resume") {
          return native;
        }
        return readNativeConfig(method, { model_provider: nativeProvider });
      },
    });
    params.provider = "openai";
    params.config = undefined;
    const appServer = createAppServerOptions();
    const common = {
      ...lifecycleParams(fixture.client),
      appServer: {
        ...appServer,
        start: {
          ...appServer.start,
          transport: "unix" as const,
          homeScope: "user" as const,
          url: "unix:///tmp/synthetic-codex.sock",
        },
      },
    };
    await startOrResumeThread(common);
    fixture.seed(native, { loaded: false, subscribed: false });
    await startOrResumeThread(common);
    for (const method of ["thread/start", "thread/resume"]) {
      const call = fixture.request.mock.calls.find(([name]) => name === method);
      expect(call, method).toBeDefined();
      expect(call?.[1]).not.toHaveProperty("modelProvider");
      expect(call?.[1]).toHaveProperty("model", params.modelId);
    }
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      modelProvider: nativeProvider,
    });
  });

  it.each([
    { nativeModel: false, changeModel: false },
    { nativeModel: true, changeModel: true },
  ])(
    "rebinds before warm reuse (native: $nativeModel, changed model: $changeModel)",
    async ({ nativeModel, changeModel }) => {
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
        if (method === "thread/resume") {
          return threadStartResult("thread-reused");
        }
        return readNativeConfig(method);
      });
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond,
        persistedThreads: ["thread-reused"],
      });
      const { client, request } = fixture;
      params.disableTools = false;
      params.config = undefined;
      const common = {
        ...lifecycleParams(client),
        appServer: {
          ...createAppServerOptions(),
          connectionClass: "local-loopback" as const,
          remoteAppsSubstrate: "preconfigured" as const,
        },
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
    },
  );
});
