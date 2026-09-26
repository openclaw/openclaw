import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi, type TestPluginApiInput } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { ensureAuthProfileStore, resolveAuthProfileOrder } from "openclaw/plugin-sdk/provider-auth";
import { resolveProviderIdForAuth } from "openclaw/plugin-sdk/provider-auth-aliases";
import { describe, expect, it, vi } from "vitest";
import plugin from "../../index.js";
import { CodexAppServerClient } from "./client.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import { isJsonObject } from "./protocol.js";
import {
  createTestParams,
  fastWait,
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

describe("registered Codex harness model attribution", () => {
  it.each(["completed", "timed out"] as const)("attributes models (%s)", async (outcome) => {
    // Protocol events own completion; host load must not spend the attempt watchdog.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const params = createTestParams();
    // Supervision replaces the helper model; this fixture supplies no host tools.
    params.hostCapabilities = Object.freeze({
      ...params.hostCapabilities,
      createToolSurface: () => [],
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
    };
    const openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateSyncKeyedStoreForTests<T>("codex", {
        ...options,
        env: { ...process.env, OPENCLAW_STATE_DIR: path.join(tempDir, "plugin-state") },
      });
    const openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) =>
      createPluginStateKeyedStoreForTests<T>("codex", {
        ...options,
        env: { ...process.env, OPENCLAW_STATE_DIR: path.join(tempDir, "plugin-state") },
      });
    const stateRuntime = { state: { openSyncKeyedStore, openKeyedStore } };
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
        let result: unknown = {};
        switch (message.method) {
          case "initialize":
            result = {
              userAgent: `codex-cli/${getMockRuntimeIdentity().serverVersion}`,
              codexHome,
            };
            break;
          case "configRequirements/read":
            result = { requirements: null };
            break;
          case "config/read":
            result = { config: { model_provider: "openai" }, origins: {} };
            break;
          case "thread/read":
            result = { thread: { ...readyThread.thread, model: nativeModel, path: rolloutPath } };
            break;
          case "thread/resume":
            send({
              method: "thread/status/changed",
              params: { threadId: "native-thread", status: { type: "notLoaded" } },
            });
            result = readyThread;
            break;
          case "turn/start":
            result = turnStartResult();
            turnStarted.resolve();
            break;
          case "turn/interrupt":
            queueMicrotask(() =>
              send({
                method: "turn/completed",
                params: {
                  threadId: "native-thread",
                  turn: { id: "turn-1", status: "interrupted", items: [] },
                },
              }),
            );
            break;
          case "thread/backgroundTerminals/list":
            result = { data: [], nextCursor: null };
            break;
          case "thread/unsubscribe":
            result = { status: "unsubscribed" };
            break;
        }
        send({ id: message.id, result });
      },
    });
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(transport.client);
    const runtime = createPluginRuntimeMock({
      modelAuth: { ensureAuthProfileStore, resolveAuthProfileOrder, resolveProviderIdForAuth },
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
    const registration = registerAgentHarness.mock.calls[0];
    if (!registration) {
      throw new Error("Expected the Codex plugin to register its harness");
    }
    const registered = registration[0];
    const events: Array<Parameters<NonNullable<EmbeddedRunAttemptParamsV2["onAgentEvent"]>>[0]> =
      [];
    params.onAgentEvent = (event) => {
      events.push(event);
    };
    const modelEvents = () =>
      events.filter((event) => event.stream === "lifecycle" && event.data.phase === "model");
    const readyModelEvent = {
      stream: "lifecycle",
      data: { phase: "model", provider: "openai", model: "ready-native-model" },
    };
    const reroutedModelEvent = {
      stream: "lifecycle",
      data: { phase: "model", provider: "openai", model: "rerouted-model" },
    };
    const run = registered.runAttempt(params);
    let next: typeof run | undefined;
    try {
      await Promise.race([
        turnStarted.promise,
        run.then((result) => {
          throw new Error("Attempt ended before turn/start", { cause: result });
        }),
      ]);
      await vi.waitFor(() => expect(modelEvents()).toEqual([readyModelEvent]), fastWait);
      expect(
        events.some((event) => event.stream === "lifecycle" && event.data.phase === "end"),
      ).toBe(false);
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
      await vi.waitFor(
        () => expect(modelEvents()).toEqual([readyModelEvent, reroutedModelEvent]),
        fastWait,
      );
      expect(events.filter((event) => event.stream === "fallback")).toEqual([
        {
          stream: "fallback",
          data: { fromModel: "ready-native-model", toModel: "rerouted-model", reason: "other" },
        },
      ]);
      if (outcome === "timed out") {
        await vi.advanceTimersByTimeAsync(params.timeoutMs);
      } else {
        transport.send({
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
      }
      const result = await run;
      if (outcome === "completed") {
        expect(result).toHaveProperty("terminal", { kind: "ok" });
      } else {
        expect(result).toMatchObject({ terminal: { kind: "timeout", aborted: true } });
        expect(requests).toContainEqual({
          method: "thread/backgroundTerminals/list",
          params: { threadId: "native-thread" },
        });
      }
      expect(result.runtimeModelSelection).toEqual({
        provider: "openai",
        model: "ready-native-model",
      });
      expect(result.assistantTexts).toEqual(outcome === "completed" ? ["Native answer."] : []);
      expect(
        events.filter((event) => event.stream === "lifecycle").map((event) => event.data.phase),
      ).toEqual(["start", "model", "model", outcome === "completed" ? "end" : "error"]);
      for (const method of ["thread/resume", "turn/start"]) {
        const matching = requests.filter((request) => request.method === method);
        expect(matching).toHaveLength(1);
        const request = matching[0];
        if (!request) {
          throw new Error(`Expected a ${method} request`);
        }
        expect(request.params).not.toHaveProperty("model");
        expect(request.params).not.toHaveProperty("modelProvider");
      }
      if (outcome === "completed") {
        nativeModel = "changed-native-model";
        turnStarted = createDeferred<void>();
        next = registered.runAttempt({ ...params, runId: "native-second-turn" });
        await Promise.race([
          turnStarted.promise,
          next.then((earlyResult) => {
            throw new Error("Second attempt ended before turn/start", { cause: earlyResult });
          }),
        ]);
        transport.send({
          method: "turn/completed",
          params: {
            threadId: "native-thread",
            turn: {
              id: "turn-1",
              status: "completed",
              items: [{ type: "agentMessage", id: "second-answer", text: "Second native answer." }],
            },
          },
        });
        const second = await next;
        expect(second).toHaveProperty("terminal", { kind: "ok" });
        expect(second.assistantTexts).toEqual(["Second native answer."]);
        expect(second.runtimeModelSelection).toEqual({ provider: "openai", model: nativeModel });
        expect(second.currentAttemptAssistant).toMatchObject({
          provider: "openai",
          model: nativeModel,
        });
        expect(bindingStore.read(sessionBindingIdentity(params))).toMatchObject({
          model: nativeModel,
        });
        expect(requests.filter(({ method }) => method === "thread/resume")).toHaveLength(1);
        expect(requests.filter(({ method }) => method === "thread/unsubscribe")).toHaveLength(0);
        expect(requests.filter(({ method }) => method === "thread/inject_items")).toHaveLength(1);
      }
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
});
