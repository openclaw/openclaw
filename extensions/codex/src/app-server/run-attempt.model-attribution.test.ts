import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import type { CodexPluginConfig } from "./config.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import {
  createTestParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT } from "./run-attempt.context-engine.test-support.js";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  createCodexAppServerBindingStore,
  sessionBindingIdentity,
} from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";
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

it("attributes the ready model and accepts reroutes only for the active turn", async () => {
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
  const bindingStore = createCodexAppServerBindingStore(
    createCodexSqliteTestBindingStateStore({
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(tempDir, "plugin-state") },
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
      webSearchThreadConfigFingerprint: DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
      historyCoveredThrough: new Date().toISOString(),
      rolloutPath,
      appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
        resolveCodexSupervisionAppServerRuntimeOptions({ pluginConfig }),
        params.agentDir,
      ),
    },
  });
  const readyThread = {
    ...threadStartResult("native-thread", { cwd: params.workspaceDir }),
    model: "ready-native-model",
    modelProvider: "openai",
  };
  const transport = createStartedThreadHarness(async (method) => {
    if (method === "config/read") {
      return { config: { model_provider: "openai" }, origins: {} };
    }
    if (method === "thread/read") {
      return { thread: { ...readyThread.thread, model: readyThread.model, path: rolloutPath } };
    }
    if (method === "thread/resume") {
      await transport.notify({
        method: "thread/status/changed",
        params: { threadId: "native-thread", status: { type: "notLoaded" } },
      });
      return readyThread;
    }
    if (method === "thread/unsubscribe") {
      return { status: "unsubscribed" };
    }
    return undefined;
  });
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
  const run = runCodexAppServerAttempt(params, {
    bindingStore,
    pluginConfig,
    runtimeModelId: params.modelId,
    nativeHookRelay: { enabled: true },
  });
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
      await transport.notify({
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
    await transport.notify({
      method: "turn/completed",
      params: {
        threadId: "native-thread",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "answer", text: "Native answer." }],
        },
      },
    });
    expect(await run).toEqual(
      expect.objectContaining({
        terminal: { kind: "ok" },
        runtimeModelSelection: { provider: "openai", model: "ready-native-model" },
        assistantTexts: ["Native answer."],
      }),
    );
    expect(
      events.filter((event) => event.stream === "lifecycle").map((event) => event.data.phase),
    ).toEqual(["start", "model", "model", "end"]);
  } finally {
    abort.abort("test cleanup");
    try {
      // Restoring clocks first discards the pending relay-replacement listener-close timer.
      await vi.runOnlyPendingTimersAsync();
    } finally {
      vi.useRealTimers();
      await transport.client.closeAndWait();
      await Promise.allSettled([run]);
    }
  }
});
