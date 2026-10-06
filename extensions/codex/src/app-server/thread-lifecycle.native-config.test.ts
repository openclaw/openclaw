import fs from "node:fs/promises";
import path from "node:path";
import { patchSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  hasCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { CodexAppServerClient, CodexAppServerRpcError } from "./client.js";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
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

describe("Codex native configuration lifecycle", () => {
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
    { changeModel: true, rotateLineage: false },
    { changeModel: false, rotateLineage: true },
  ])(
    "rebinds before native warm reuse (changed model: $changeModel, rotated lineage: $rotateLineage)",
    async ({ changeModel, rotateLineage }) => {
      registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
      await writeCodexAppServerBinding(sessionFile, {
        webSearchThreadConfigFingerprint: JSON.stringify({
          "features.standalone_web_search": false,
          web_search: "cached",
        }),
        threadId: "thread-reused",
        clientId: "client-before-restart",
        preserveNativeModel: true,
        model: threadStartResult().model,
        modelProvider: threadStartResult().modelProvider,
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
        "thread/read",
      ]);
      if (rotateLineage) {
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
        const retainedBinding = await readCodexAppServerBinding(sessionFile);
        const nativeRequest = CodexAppServerClient.prototype.request.bind(client);
        request.mockImplementation(async (...args) => {
          const response = await nativeRequest(...args);
          if (args[0] === "thread/read") {
            // The wire read still completes normally. Change the durable lineage
            // while warm admission awaits it, without changing the native binding.
            await patchSessionEntry({
              agentId: "main",
              sessionKey: "agent:main:session-1",
              storePath: resolveStorePath(undefined, { agentId: "main" }),
              update: () => ({ previousSessionId: "replaced-predecessor" }),
            });
          }
          return response;
        });
        await expect(startOrResumeThread(common)).rejects.toThrow("active");
        expect(request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(
          resumeCount,
        );
        expect(
          request.mock.calls.some(
            ([method]) => method === "turn/interrupt" || method === "thread/archive",
          ),
        ).toBe(false);
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(retainedBinding);
        expect(hasCodexAppServerLiveThread(client, warm.threadId)).toBe(false);
        expect(client.getCloseError()).toBeUndefined();
        expect(
          request.mock.calls.filter(([method]) => method === "thread/unsubscribe"),
        ).toHaveLength(1);
      }
    },
  );
});

it("reuses isolated retained threads until native skills change", async () => {
  vi.stubEnv("HOME", tempDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "isolated-state"));
  const sessionFile = path.join(tempDir, "warm-isolated-session.jsonl");
  const workspaceDir = path.join(tempDir, "warm-isolated-workspace");
  const personalSkill = path.join(tempDir, ".claude", "skills", "personal", "SKILL.md");
  await fs.mkdir(path.dirname(personalSkill), { recursive: true });
  await fs.writeFile(personalSkill, "personal");
  const personalSkillRealPath = await fs.realpath(personalSkill);
  const nativeSkillPaths = [personalSkillRealPath];
  let starts = 0;
  const request = vi.fn(async (method: string, _requestParams?: unknown) => {
    if (method === "config/read") {
      return { config: {}, origins: {}, layers: [] };
    }
    if (method === "configRequirements/read") {
      return { requirements: null };
    }
    if (method === "skills/list") {
      return {
        data: [
          {
            cwd: workspaceDir,
            errors: [],
            skills: nativeSkillPaths.map((skillPath) => ({
              name: path.basename(path.dirname(skillPath)),
              description: "Personal skill",
              path: skillPath,
              scope: "user",
              enabled: true,
            })),
          },
        ],
      };
    }
    if (method === "thread/start") {
      starts += 1;
      return threadStartResult(
        starts === 1 ? "thread-warm-isolated" : "thread-refreshed-isolation",
      );
    }
    if (method === "thread/unsubscribe") {
      return {};
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const fixture = createFakeCodexAppServerClient(request);
  const { client } = fixture;
  ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
  const params = createParams(sessionFile, workspaceDir);
  params.disableTools = false;
  params.config = undefined;
  registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);
  const common: Parameters<typeof startOrResumeThread>[0] = {
    client,
    params,
    cwd: workspaceDir,
    dynamicTools: [],
    appServer: {
      ...createAppServerOptions(),
      connectionClass: "local-loopback",
    },
    userMcpServersEnabled: false,
  };

  try {
    const started = await startOrResumeThread(common);
    await expect(
      retainCodexAppServerLiveThread(
        client,
        started.threadId,
        undefined,
        started.liveThreadConfigFingerprint,
      ),
    ).resolves.toBe(true);
    const warm = await startOrResumeThread(common);
    expect(warm).toMatchObject({
      threadId: "thread-warm-isolated",
      lifecycle: { action: "resumed" },
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "skills/list",
      "config/read",
      "configRequirements/read",
      "thread/start",
      "config/read",
      "configRequirements/read",
    ]);
    const startRequest = request.mock.calls.find(([method]) => method === "thread/start")?.[1];
    expect(startRequest).toMatchObject({
      config: {
        "skills.include_instructions": false,
        "skills.config": [{ path: personalSkillRealPath, enabled: false }],
      },
    });
    await expect(
      retainCodexAppServerLiveThread(
        client,
        warm.threadId,
        warm.liveThreadOwnership?.release,
        warm.liveThreadConfigFingerprint,
      ),
    ).resolves.toBe(true);

    const newPersonalSkill = path.join(tempDir, ".claude", "skills", "updated", "SKILL.md");
    await fs.mkdir(path.dirname(newPersonalSkill), { recursive: true });
    await fs.writeFile(newPersonalSkill, "updated");
    const newPersonalSkillRealPath = await fs.realpath(newPersonalSkill);
    nativeSkillPaths.push(newPersonalSkillRealPath);
    await fixture.notify({ method: "skills/changed", params: {} });

    await expect(startOrResumeThread(common)).resolves.toMatchObject({
      threadId: "thread-refreshed-isolation",
      lifecycle: { action: "started" },
    });
    const startRequests = request.mock.calls.filter(([method]) => method === "thread/start");
    expect(startRequests).toHaveLength(2);
    expect(startRequests[1]?.[1]).toMatchObject({
      config: {
        "skills.include_instructions": false,
        "skills.config": [
          { path: personalSkillRealPath, enabled: false },
          { path: newPersonalSkillRealPath, enabled: false },
        ],
      },
    });
  } finally {
    fixture.close();
  }
});
