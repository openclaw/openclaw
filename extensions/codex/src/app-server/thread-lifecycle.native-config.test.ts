import fs from "node:fs/promises";
import path from "node:path";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { resetLogger, setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
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
  createAgentLifecycleHarness,
  bindProductionHarnessHostCapabilitiesForTest,
  createParams,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import {
  createAppServerOptions,
  nativeQuestionConfigFixture,
  startOrResumeThread,
} from "./thread-lifecycle.test-fixtures.js";
import { CodexIncognitoPolicyChangeError } from "./thread-policy.js";
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

  const retainLiveThread = (
    client: Parameters<typeof startOrResumeThread>[0]["client"],
    binding: Awaited<ReturnType<typeof startOrResumeThread>>,
  ) =>
    retainCodexAppServerLiveThread(
      client,
      binding.threadId,
      binding.liveThreadOwnership?.release,
      binding.liveThreadConfigFingerprint,
      null,
      binding.liveThreadEphemeralPolicy,
    );

  function readNativeConfig(method: string, config: JsonObject = {}) {
    if (method === "config/read") {
      return { config, origins: {}, layers: [] };
    }
    if (method === "configRequirements/read") {
      return { requirements: null };
    }
    throw new Error(`unexpected method: ${method}`);
  }

  it.each([
    "unused",
    "recorded history",
    "recorded history after restart",
    "loaded unowned",
  ] as const)("continues a managed conversation with a lost inference route: %s", async (state) => {
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    const fixture = await createAgentLifecycleHarness({
      respond: async (method) => {
        if (method === "account/read") {
          return { account: { type: "apiKey" } };
        }
        if (method === "thread/start") {
          return threadStartResult("replacement-thread");
        }
        return readNativeConfig(method);
      },
    });
    ownCodexInferenceClient(fixture.client);
    if (state === "loaded unowned") {
      fixture.seed(threadStartResult("lost-thread"), { loaded: true, subscribed: false });
    }
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "lost-thread",
      clientId:
        state === "recorded history after restart"
          ? "previous-client"
          : fixture.client.getInstanceId(),
      cwd: workspaceDir,
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      webSearchThreadConfigFingerprint: JSON.stringify({
        "features.standalone_web_search": false,
        web_search: "disabled",
      }),
      ...(state.startsWith("recorded history")
        ? { historyCoveredThrough: "2026-10-01T00:00:00.000Z" }
        : {}),
    });
    const before = await readCodexAppServerBinding(sessionFile);
    let recoveryRpcMethod: unknown;
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (
        event.type === "log.record" &&
        event.message === "codex app-server thread resume failed; starting a new thread"
      ) {
        recoveryRpcMethod = event.attributes?.rpcMethod;
      }
    });
    setLoggerOverride({ level: "warn", file: path.join(tempDir, "recovery.log") });
    try {
      const next = startOrResumeThread(lifecycleParams(fixture.client));
      if (state === "unused") {
        await expect(next).resolves.toMatchObject({ threadId: "replacement-thread" });
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
          threadId: "replacement-thread",
        });
        expect(getCodexInferenceThread(fixture.client, "replacement-thread")).toBeDefined();
        await waitForDiagnosticEventsDrained();
        expect(recoveryRpcMethod).toBe("thread/read");
      } else {
        await expect(next).rejects.toThrow(
          state.startsWith("recorded history") ? "thread not loaded" : "no owned inference route",
        );
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(before);
      }
      expect(
        fixture.request.mock.calls.filter(([method]) => method === "thread/start"),
      ).toHaveLength(state === "unused" ? 1 : 0);
    } finally {
      unsubscribe();
      setLoggerOverride(null);
      resetLogger();
      fixture.client.close();
    }
  });

  it.each([undefined, false, true])(
    "refreshes callable question policy and authored native configuration (%s)",
    async (authored) => {
      let enabled = authored;
      const native = threadStartResult("question-thread", { cwd: workspaceDir });
      const fixture = await createAgentLifecycleHarness({
        respond: async (method) => {
          if (method === "thread/start" || method === "thread/resume") {
            return native;
          }
          if (method === "thread/inject_items") {
            return {};
          }
          return method === "config/read"
            ? nativeQuestionConfigFixture(enabled)
            : readNativeConfig(method);
        },
      });
      const common = { ...lifecycleParams(fixture.client), askUserAvailable: true };
      const binding = await startOrResumeThread(common);
      await retainCodexAppServerLiveThread(
        fixture.client,
        binding.threadId,
        binding.liveThreadOwnership?.release,
        binding.liveThreadConfigFingerprint,
      );
      const start = fixture.request.mock.calls.find(([method]) => method === "thread/start")?.[1];
      expect(start).toBeDefined();
      const startConfig = isJsonObject(start) && isJsonObject(start.config) ? start.config : {};
      expect(startConfig["tools.experimental_request_user_input.enabled"]).toBe(
        authored ? undefined : false,
      );
      enabled = authored !== true;
      const changed = await startOrResumeThread(common);
      expect(changed.threadId).toBe(binding.threadId);
      const refreshed = fixture.request.mock.calls.filter(([method]) => method === "thread/resume");
      expect(refreshed).toHaveLength(1);
      const refresh = refreshed[0]?.[1];
      const refreshConfig =
        isJsonObject(refresh) && isJsonObject(refresh.config) ? refresh.config : {};
      expect(refreshConfig["tools.experimental_request_user_input.enabled"]).toBe(
        enabled ? undefined : false,
      );
      await retainCodexAppServerLiveThread(
        fixture.client,
        changed.threadId,
        changed.liveThreadOwnership?.release,
        changed.liveThreadConfigFingerprint,
      );
      const next = await startOrResumeThread({ ...common, askUserAvailable: false });
      expect(next.threadId).toBe(binding.threadId);
      const resumes = fixture.request.mock.calls.filter(([method]) => method === "thread/resume");
      expect(resumes).toHaveLength(enabled ? 1 : 2);
      if (!enabled) {
        const resumed = resumes.at(-1)?.[1];
        const config = isJsonObject(resumed) && isJsonObject(resumed.config) ? resumed.config : {};
        expect(config).not.toHaveProperty("tools.experimental_request_user_input.enabled");
      }
    },
  );

  it("resumes the bound thread after replacing the inference proxy client", async () => {
    const createClient = (persistedThreads: string[] = []) =>
      createAgentLifecycleHarness({
        persistedThreads,
        respond: async (method) => {
          if (method === "account/read") {
            return { account: { type: "apiKey" } };
          }
          if (method === "thread/start" || method === "thread/resume") {
            return threadStartResult("proxy-thread");
          }
          return readNativeConfig(method);
        },
      });
    const first = await createClient();
    ownCodexInferenceClient(first.client);
    let firstUrl: string | undefined;
    try {
      const binding = await startOrResumeThread({
        ...lifecycleParams(first.client),
        nativeCodeModeEnabled: false,
      });
      firstUrl = getCodexInferenceThread(first.client, binding.threadId)?.baseUrl;
      expect(binding.threadId).toBe("proxy-thread");
      expect(binding.restrictedThreadConfigFingerprint).toBeDefined();
    } finally {
      first.client.close();
    }
    const second = await createClient(["proxy-thread"]);
    ownCodexInferenceClient(second.client);
    try {
      const binding = await startOrResumeThread({
        ...lifecycleParams(second.client),
        nativeCodeModeEnabled: false,
      });
      expect(binding.threadId).toBe("proxy-thread");
      expect(binding.lifecycle.action).toBe("resumed");
      expect(getCodexInferenceThread(second.client, binding.threadId)?.baseUrl).not.toBe(firstUrl);
      expect(second.request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
    } finally {
      second.client.close();
    }
  });

  // An authored native base keeps its place on start and cold resume; OpenClaw's base
  // then rides the developer carrier.
  it.each([
    [false, undefined],
    [true, "model_instructions_file"],
    [false, "instructions"],
  ] as const)(
    "suppresses plugin suggestions and places the base on start and resume (authored: %s, native base: %s)",
    async (authored, nativeBaseKey) => {
      registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
      const native = threadStartResult("plugin-thread", { cwd: workspaceDir });
      const config: JsonObject = {
        "features.apps": true,
        "features.plugins": true,
        plugins: { "calendar@fixture": { enabled: true } },
        apps: { calendar: { enabled: true } },
        ...(authored
          ? { "features.tool_suggest": true, "features.recommended_plugins": true }
          : {}),
      };
      const fixture = await createAgentLifecycleHarness({
        respond: async (method) => {
          if (method === "thread/start" || method === "thread/resume") {
            return native;
          }
          return readNativeConfig(
            method,
            nativeBaseKey ? { [nativeBaseKey]: "Operator policy" } : {},
          );
        },
      });
      const common = { ...lifecycleParams(fixture.client), config };
      const carrierKey = nativeBaseKey ? "developerInstructions" : "baseInstructions";
      const threads = [await startOrResumeThread(common)];
      fixture.seed(native, { loaded: false, subscribed: false });
      threads.push(await startOrResumeThread(common));

      const requests = fixture.writes
        .map((line): unknown => JSON.parse(line))
        .filter(isJsonObject)
        .filter((frame) => frame.method === "thread/start" || frame.method === "thread/resume");
      expect(requests.map((frame) => frame.method)).toEqual(["thread/start", "thread/resume"]);
      for (const [index, request] of requests.entries()) {
        // Reports read the base the lifecycle placed, whichever carrier holds it; warm reuse
        // compares the resume request with the creation request.
        const placed = threads[index]?.preparedOpenClawBaseInstructions;
        expect(placed).toBe(threads[0]?.preparedOpenClawBaseInstructions);
        expect(placed).toContain("You are a personal assistant running inside OpenClaw.");
        const carrier = isJsonObject(request.params) ? request.params[carrierKey] : undefined;
        expect(
          typeof carrier === "string" &&
            carrier.startsWith(nativeBaseKey ? `<openclaw_thread_policy>\n${placed}` : `${placed}`),
        ).toBe(true);
        expect(request.params).toMatchObject({
          config: {
            "features.tool_suggest": false,
            "features.recommended_plugins": false,
            "features.apps": true,
            "features.plugins": true,
            plugins: { "calendar@fixture": { enabled: true } },
            apps: { calendar: { enabled: true } },
          },
        });
        expect(isJsonObject(request.params) && "baseInstructions" in request.params).toBe(
          !nativeBaseKey,
        );
      }
    },
  );

  // A replacement replaces the base too, as on the default engine. A live thread keeps its ID and
  // history: it is unloaded, then cold-resumed with the explicit base, which beats its saved one.
  it.each([
    ["from creation", undefined],
    ["from creation beside a native base", "instructions"],
    ["after creation", undefined],
  ] as const)("replaces the base for a systemPrompt replacement %s", async (when, key) => {
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    const native = threadStartResult("replaced-thread", { cwd: workspaceDir });
    const fixture = await createAgentLifecycleHarness({
      respond: async (method) =>
        method === "thread/start" || method === "thread/resume"
          ? native
          : method === "thread/inject_items"
            ? {}
            : readNativeConfig(method, key ? { [key]: "Operator policy" } : {}),
    });
    const replaced = {
      ...lifecycleParams(fixture.client),
      developerInstructions: "",
      systemPromptReplaced: true,
    };
    const live = when === "after creation";
    const created = await startOrResumeThread(live ? lifecycleParams(fixture.client) : replaced);
    if (live) {
      await retainLiveThread(fixture.client, created);
    } else {
      fixture.seed(native, { loaded: false, subscribed: false });
    }
    const resumed = await startOrResumeThread(replaced);

    const frames = fixture.writes
      .map((line): unknown => JSON.parse(line))
      .filter(isJsonObject)
      .map((frame) => [frame.method, isJsonObject(frame.params) ? frame.params : {}] as const)
      .filter(
        ([method]) =>
          typeof method === "string" && /^thread\/(?:start|unsubscribe|resume)$/u.test(method),
      );
    expect(frames.map(([method]) => method)).toEqual(
      live
        ? ["thread/start", "thread/unsubscribe", "thread/resume"]
        : ["thread/start", "thread/resume"],
    );
    expect(resumed.threadId).toBe(created.threadId);
    expect(frames[0]?.[1].baseInstructions).toEqual(
      live
        ? expect.stringContaining("personal assistant running inside OpenClaw")
        : key
          ? undefined
          : "",
    );
    expect(frames.at(-1)?.[1]).toMatchObject({
      developerInstructions: "<openclaw_thread_policy>\n\n</openclaw_thread_policy>",
    });
    expect(frames.at(-1)?.[1].baseInstructions).toBe(key ? undefined : "");
    expect(resumed.preparedOpenClawBaseInstructions).toBeUndefined();
  });

  // The native-owned incognito continuation sends nothing, so reports keep the creation base.
  it("reports the creation base on a native-owned incognito continuation", async () => {
    params.sessionKey = "agent:main:dashboard:incognito-native-owned";
    registerCodexTestSessionIdentity(sessionFile, "session-1", params.sessionKey);
    const fixture = await createAgentLifecycleHarness({
      respond: async (method) =>
        method === "thread/start"
          ? threadStartResult("native-owned-thread", { cwd: workspaceDir })
          : readNativeConfig(method),
    });
    const first = await startOrResumeThread(lifecycleParams(fixture.client));
    const creationBase = first.preparedOpenClawBaseInstructions;
    const stored = await readCodexAppServerBinding(sessionFile);
    if (stored?.threadId !== first.threadId) {
      throw new Error("expected the started incognito binding");
    }
    await writeCodexAppServerBinding(sessionFile, { ...stored, preserveNativeModel: true });
    await retainLiveThread(fixture.client, first);
    params.promptMode = "minimal"; // a base this live thread never receives
    const continued = await startOrResumeThread(lifecycleParams(fixture.client));

    expect(continued).toMatchObject({ threadId: first.threadId, lifecycle: { action: "resumed" } });
    expect(continued.preparedOpenClawBaseInstructions).toBe(creationBase);
    const threadRequests = fixture.writes.filter((line) =>
      /"thread\/(?:start|resume)"/u.test(line),
    );
    expect(threadRequests).toHaveLength(1);
  });

  it("refuses warm incognito reuse when OpenClaw's base changes beside an authored native base", async () => {
    params.sessionKey = "agent:main:dashboard:incognito-operator-base";
    registerCodexTestSessionIdentity(sessionFile, "session-1", params.sessionKey);
    const fixture = await createAgentLifecycleHarness({
      respond: async (method) => {
        if (method === "thread/start") {
          return threadStartResult("incognito-operator-thread", { cwd: workspaceDir });
        }
        return readNativeConfig(method, { instructions: "Operator policy" });
      },
    });
    const first = await startOrResumeThread(lifecycleParams(fixture.client));
    expect(first.liveThreadEphemeralPolicy?.baseInstructions).toContain(
      "You are a personal assistant running inside OpenClaw.",
    );
    await retainLiveThread(fixture.client, first);
    const unchanged = await startOrResumeThread(lifecycleParams(fixture.client));
    expect(unchanged.threadId).toBe(first.threadId);
    await retainLiveThread(fixture.client, unchanged);
    // Only OpenClaw's base text changes; it rides the developer carrier for this thread.
    params.promptMode = "minimal";
    await expect(startOrResumeThread(lifecycleParams(fixture.client))).rejects.toBeInstanceOf(
      CodexIncognitoPolicyChangeError,
    );
  });

  it.each([false, true])(
    "validates every operator parent provider in final native config (overridden: %s)",
    async (overridden) => {
      const fixture = await createAgentLifecycleHarness({
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
      const fixture = await createAgentLifecycleHarness({
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
      const fixture = await createAgentLifecycleHarness({
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
    const fixture = await createAgentLifecycleHarness({
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
    { changeModel: true, rotateLineage: false, revokeDuringBindingRead: false },
    { changeModel: false, rotateLineage: true, revokeDuringBindingRead: false },
    { changeModel: false, rotateLineage: false, revokeDuringBindingRead: true },
  ])(
    "rebinds before native warm reuse (changed model: $changeModel, rotated lineage: $rotateLineage, revoked binding read: $revokeDuringBindingRead)",
    async ({ changeModel, rotateLineage, revokeDuringBindingRead }) => {
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
      const fixture = await createAgentLifecycleHarness({
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
        "skills/list",
        "config/read",
        "configRequirements/read",
        "thread/read",
        "thread/resume",
        "thread/inject_items",
        "skills/list",
        "config/read",
        "configRequirements/read",
        "thread/read",
      ]);
      if (rotateLineage || revokeDuringBindingRead) {
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
        const closeHost = revokeDuringBindingRead
          ? await bindProductionHarnessHostCapabilitiesForTest(params)
          : undefined;
        let nativeReadCompleted = false;
        const readBinding = testCodexAppServerBindingStore.readAsync.bind(
          testCodexAppServerBindingStore,
        );
        const bindingRead = revokeDuringBindingRead
          ? vi
              .spyOn(testCodexAppServerBindingStore, "readAsync")
              .mockImplementation(async (identity) => {
                const binding = await readBinding(identity);
                if (nativeReadCompleted) {
                  closeHost?.();
                }
                return binding;
              })
          : undefined;
        const nativeRequest = CodexAppServerClient.prototype.request.bind(client);
        request.mockImplementation(async (...args) => {
          const response = await nativeRequest(...args);
          if (args[0] === "thread/read") {
            nativeReadCompleted = true;
            // The wire read still completes normally. Change the durable lineage
            // while warm admission awaits it, without changing the native binding.
            if (rotateLineage) {
              await patchSessionEntry({
                agentId: "main",
                sessionKey: "agent:main:session-1",
                storePath: resolveStorePath(undefined, { agentId: "main" }),
                update: () => ({ previousSessionId: "replaced-predecessor" }),
              });
            }
          }
          return response;
        });
        try {
          await expect(startOrResumeThread(common)).rejects.toThrow(
            "Codex warm thread ownership changed",
          );
        } finally {
          bindingRead?.mockRestore();
          closeHost?.();
        }
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
