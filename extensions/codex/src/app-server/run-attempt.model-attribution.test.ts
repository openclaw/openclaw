import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
  PluginStateActionAuthority,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi, type TestPluginApiInput } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createPluginRuntimeMock,
  runInHarnessToolAuthorityForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreAsync,
  resolveAuthProfileOrder,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveProviderIdForAuth } from "openclaw/plugin-sdk/provider-auth-aliases";
import { expect, it, vi } from "vitest";
import plugin from "../../index.js";
import { CodexAppServerClient } from "./client.js";
import type { CodexPluginConfig } from "./config.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import { isJsonObject } from "./protocol.js";
import {
  createTestParams,
  getMockRuntimeIdentity,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  createCodexAppServerBindingStore,
  sessionBindingIdentity,
} from "./session-binding.js";
import { createCodexRuntimeTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";
import { createClientHarness } from "./test-support.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";

setupRunAttemptTestHooks();

async function beforeResult<T>(signal: Promise<void>, run: Promise<T>, stage: string) {
  await Promise.race([
    signal,
    run.then((result) => {
      throw new Error(`Attempt ended before ${stage}`, { cause: result });
    }),
  ]);
}

const modelEvent = (model: string) => ({
  stream: "lifecycle",
  data: { phase: "model", provider: "openai", model },
});

it("attributes completed models and refreshes their selection on warm reuse", async () => {
  // Protocol events own completion; host load must not spend the attempt watchdog.
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  const params = createTestParams();
  // Supervision replaces the helper model; this fixture supplies no host tools.
  params.hostCapabilities = Object.freeze({
    ...params.hostCapabilities,
    createToolSurfaceAsync: async () => [],
  });
  params.agentDir = path.join(tempDir, "agent");
  params.provider = "anthropic";
  params.modelId = "picker-model";
  params.model = { ...params.model, provider: params.provider, id: params.modelId };
  const abort = new AbortController();
  params.abortSignal = abort.signal;
  await attachSqliteSessionTarget(params, path.join(tempDir, "session.sqlite"), params.sessionId);

  const codexHome = path.join(tempDir, "native-home");
  vi.stubEnv("CODEX_HOME", codexHome);
  const rolloutPath = path.join(codexHome, "sessions", "native-thread.jsonl");
  await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
  await fs.writeFile(
    rolloutPath,
    `${JSON.stringify({ type: "session_meta", payload: { id: "native-thread", model_provider: "openai" } })}\n`,
  );
  const pluginConfig = {
    appServer: {
      mode: "guardian",
      command: process.execPath,
      args: ["app-server"],
      transport: "stdio",
    },
    supervision: { enabled: true },
    sessionCatalog: { enabled: false },
  } satisfies CodexPluginConfig;
  const stateEnv = { ...process.env, OPENCLAW_STATE_DIR: path.join(tempDir, "plugin-state") };
  const openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("codex", {
      ...options,
      env: stateEnv,
    });
  const openKeyedStoreV2 = <T>(
    options: OpenAsyncKeyedStoreOptions,
    authority?: PluginStateActionAuthority,
  ) =>
    createPluginStateKeyedStoreForTests<T>("codex", {
      ...options,
      env: stateEnv,
    }).withCurrent(authority ?? { assertCurrent() {} });
  const stateRuntime = { state: { openSyncKeyedStore, openKeyedStoreV2 } };
  const bindingStore = createCodexAppServerBindingStore(
    createCodexRuntimeTestBindingStateStore(stateRuntime, {
      namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
      maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
  );
  await bindingStore.mutate(sessionBindingIdentity(params), {
    kind: "set",
    binding: {
      threadId: "native-thread",
      cwd: params.workspaceDir,
      model: "cached-native-model",
      modelProvider: "openai",
      preserveNativeModel: true,
      connectionScope: "supervision",
      supervisionSourceThreadId: "native-thread",
      conversationSourceTransferComplete: true,
      dynamicToolsFingerprint: codexDynamicToolsFingerprint([]),
      webSearchThreadConfigFingerprint: JSON.stringify({
        "features.standalone_web_search": false,
        web_search: "disabled",
      }),
      historyCoveredThrough: new Date().toISOString(),
      rolloutPath,
      appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
        resolveCodexSupervisionAppServerRuntimeOptions({ pluginConfig }),
        params.agentDir,
      ),
    },
  });
  let nativeModel = "ready-native-model";
  const readyThread = {
    ...threadStartResult("native-thread", { cwd: params.workspaceDir }),
    model: "ready-native-model",
    modelProvider: "openai",
  };
  let turnStarted = createDeferred<void>();
  const requests: Array<{ method: string; params: unknown }> = [];
  const responses: Record<string, () => unknown> = {
    initialize: () => ({
      userAgent: `codex-cli/${getMockRuntimeIdentity().serverVersion}`,
      codexHome,
    }),
    "configRequirements/read": () => ({ requirements: null }),
    "config/read": () => ({ config: { model_provider: "openai" }, origins: {} }),
    "thread/read": () => ({
      thread: { ...readyThread.thread, model: nativeModel, path: rolloutPath },
    }),
    "thread/resume": () => {
      transport.send({
        method: "thread/status/changed",
        params: { threadId: "native-thread", status: { type: "notLoaded" } },
      });
      return readyThread;
    },
    "turn/start": () => {
      turnStarted.resolve();
      return turnStartResult();
    },
    "turn/interrupt": () => {
      queueMicrotask(() => sendTurn("interrupted"));
      return {};
    },
    "thread/backgroundTerminals/list": () => ({ data: [], nextCursor: null }),
    "thread/unsubscribe": () => ({ status: "unsubscribed" }),
  };
  const transport = createClientHarness({
    onWrite(line, send) {
      const message: unknown = JSON.parse(line);
      if (
        !isJsonObject(message) ||
        typeof message.method !== "string" ||
        message.id === undefined
      ) {
        return;
      }
      requests.push({ method: message.method, params: message.params });
      send({ id: message.id, result: responses[message.method]?.() ?? {} });
    },
  });
  const sendTurn = (
    status: string,
    items: Array<{ type: string; id: string; text: string }> = [],
  ) =>
    transport.send({
      method: "turn/completed",
      params: {
        threadId: "native-thread",
        turn: { id: "turn-1", status, items },
      },
    });
  vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(transport.client);
  const runtime = createPluginRuntimeMock({
    modelAuth: {
      ensureAuthProfileStore,
      ensureAuthProfileStoreAsync,
      resolveAuthProfileOrder,
      resolveProviderIdForAuth,
    },
    config: { current: () => ({ plugins: { entries: { codex: { config: pluginConfig } } } }) },
    state: stateRuntime.state,
  });
  const registerAgentHarness = vi.fn<NonNullable<TestPluginApiInput["registerAgentHarness"]>>();
  plugin.register(
    createTestPluginApi({
      id: "codex",
      rootDir: fileURLToPath(new URL("../../", import.meta.url)),
      pluginConfig,
      runtime,
      registerAgentHarness,
    }),
  );
  expect(registerAgentHarness).toHaveBeenCalledOnce();
  const [registered] = registerAgentHarness.mock.calls[0]!;
  const events: Array<Parameters<NonNullable<EmbeddedRunAttemptParamsV2["onAgentEvent"]>>[0]> = [];
  let modelPublished = createDeferred<void>();
  params.onAgentEvent = (event) => {
    events.push(event);
    if (event.stream === "lifecycle" && event.data.phase === "model") {
      modelPublished.resolve();
    }
  };
  const modelEvents = () =>
    events.filter((event) => event.stream === "lifecycle" && event.data.phase === "model");
  const readyModelEvent = modelEvent("ready-native-model");
  const reroutedModelEvent = modelEvent("rerouted-model");
  const runAttempt = registered.runAttempt.bind(registered);
  const run = runInHarnessToolAuthorityForTest(params, "codex", runAttempt);
  let next: typeof run | undefined;
  try {
    await beforeResult(modelPublished.promise, run, "model attribution");
    expect(modelEvents()).toEqual([readyModelEvent]);
    expect(events.some((event) => event.stream === "lifecycle" && event.data.phase === "end")).toBe(
      false,
    );
    modelPublished = createDeferred<void>();
    for (const [threadId, turnId, toModel] of [
      ["foreign-thread", "turn-1", "foreign-thread-model"],
      ["native-thread", "foreign-turn", "foreign-turn-model"],
      ["native-thread", "turn-1", "rerouted-model"],
    ]) {
      transport.send({
        method: "model/rerouted",
        params: { threadId, turnId, fromModel: "ready-native-model", toModel, reason: "other" },
      });
    }
    await beforeResult(modelPublished.promise, run, "rerouted model attribution");
    expect(modelEvents()).toEqual([readyModelEvent, reroutedModelEvent]);
    expect(events.filter((event) => event.stream === "fallback")).toEqual([
      {
        stream: "fallback",
        data: { fromModel: "ready-native-model", toModel: "rerouted-model", reason: "other" },
      },
    ]);
    sendTurn("completed", [{ type: "agentMessage", id: "answer", text: "Native answer." }]);
    const result = await run;
    expect(result).toEqual(
      expect.objectContaining({
        terminal: { kind: "ok" },
        runtimeModelSelection: { provider: "openai", model: "ready-native-model" },
        assistantTexts: ["Native answer."],
      }),
    );
    expect(
      events.filter((event) => event.stream === "lifecycle").map((event) => event.data.phase),
    ).toEqual(["start", "model", "model", "end"]);
    for (const method of ["thread/resume", "turn/start"]) {
      const matching = requests.filter((request) => request.method === method);
      expect(matching).toHaveLength(1);
      expect(matching[0]!.params).not.toHaveProperty("model");
      expect(matching[0]!.params).not.toHaveProperty("modelProvider");
    }
    nativeModel = "changed-native-model";
    turnStarted = createDeferred<void>();
    next = runInHarnessToolAuthorityForTest(
      { ...params, runId: "native-second-turn" },
      "codex",
      runAttempt,
    );
    await beforeResult(turnStarted.promise, next, "second turn/start");
    sendTurn("completed", [
      { type: "agentMessage", id: "second-answer", text: "Second native answer." },
    ]);
    const second = await next;
    expect(second).toEqual(
      expect.objectContaining({
        terminal: { kind: "ok" },
        assistantTexts: ["Second native answer."],
        runtimeModelSelection: { provider: "openai", model: nativeModel },
        currentAttemptAssistant: expect.objectContaining({
          provider: "openai",
          model: nativeModel,
        }),
      }),
    );
    expect(bindingStore.read(sessionBindingIdentity(params))).toMatchObject({
      model: nativeModel,
    });
    expect(requests.filter(({ method }) => method === "thread/resume")).toHaveLength(1);
    expect(requests.filter(({ method }) => method === "thread/unsubscribe")).toHaveLength(0);
    expect(requests.filter(({ method }) => method === "thread/inject_items")).toHaveLength(1);
  } finally {
    abort.abort("test cleanup");
    try {
      // Restoring clocks first discards the pending relay-replacement listener-close timer.
      await vi.runOnlyPendingTimersAsync();
    } finally {
      vi.useRealTimers();
      await transport.client.closeAndWait();
      await Promise.allSettled([run, next]);
      await registered.dispose?.();
    }
  }
});
