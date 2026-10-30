import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import { wasCodexAppServerThreadClosed } from "./client-thread-closure.js";
import { CodexAppServerClient } from "./client.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject } from "./protocol.js";
import { createCodexAppServerBindingStore } from "./session-binding.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";
import {
  getOrCreateSharedClientEntry,
  getSharedCodexAppServerClientState,
  retainSharedClientEntry,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client-lifecycle.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";
import { startOrResumeThread } from "./thread-lifecycle-run.js";
import { createCodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import { releaseCodexBoundLiveThread } from "./thread-lifecycle-warm.js";
import {
  createParams,
  resetThreadLifecycleTestFixtures,
} from "./thread-lifecycle.test-fixtures.js";
import {
  listenForNativeResponses,
  nativeAppServerOptions,
  nativeProviderConfig,
  runNativeTurn,
  sendNativeResponse,
} from "./thread-native.test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.unmock("node:child_process");
afterEach(() => {
  resetThreadLifecycleTestFixtures();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it(
  "resumes after an untracked native closure while its sibling stays usable and fenced",
  { timeout: 30_000 },
  async (context) => {
    const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
      context.onTestFinished(async () => {
        await closeOpenClawStateDatabaseAsync();
        cleanup();
      }),
    );
    const root = await fs.realpath(tempDirs.make("codex-handoff-native-"));
    const native = await createCodexNativeTestState(root);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("HOME", native.env.HOME);
    vi.stubEnv("CODEX_HOME", native.codexHome);
    let providerRequests = 0;
    const port = await listenForNativeResponses(context, (request, response) => {
      request.resume();
      request.on("end", () => {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        providerRequests += 1;
        sendNativeResponse(response, "handoff-response-" + providerRequests, {
          type: "message",
          role: "assistant",
          id: "handoff-answer-" + providerRequests,
          content: [{ type: "output_text", text: "NATIVE_HANDOFF_OK" }],
        });
      });
    });
    await fs.writeFile(
      path.join(native.codexHome, "config.toml"),
      nativeProviderConfig(
        "handoff-proof",
        port,
        ['sandbox_mode="read-only"', "allow_login_shell=false", "thread_unload_delay_secs=0"],
        ["shell_snapshot=false"],
      ),
    );
    const appServer = { ...nativeAppServerOptions(native), sandbox: "read-only" as const };
    // The raw old client models a process created before this build installed closure tracking.
    const old = await CodexAppServerClient.start(appServer.start);
    context.onTestFinished(async () => {
      await old.closeAndWait();
    });
    // Two processes initializing a fresh CODEX_HOME race Codex's SQLite state setup.
    await old.initialize();
    expect(old.getServerVersion()).toBe(CODEX_APP_SERVER_VERSION);
    const successor = await createIsolatedCodexAppServerClient({
      startOptions: appServer.start,
      agentDir: path.join(root, "agent"),
      authProfileId: null,
      config: {},
      timeoutMs: 10_000,
    });
    const shared = getSharedCodexAppServerClientState();
    let releaseSibling: (() => void) | undefined;
    try {
      const params = {
        ...createParams(path.join(root, "session.jsonl"), native.cwd),
        agentId: "main",
        agentDir: path.join(root, "agent"),
        modelId: "gpt-5.6-luna",
        disableTools: false,
      };
      const bindingStore = createCodexAppServerBindingStore(createCodexTestBindingStateStore());
      const common = {
        bindingStore,
        params,
        cwd: native.cwd,
        dynamicTools: [],
        appServer,
        userMcpServersEnabled: false,
        signal: AbortSignal.timeout(20_000),
      };
      const target = await startOrResumeThread({ ...common, client: old });
      await expect(
        runNativeTurn(old, target.threadId, "Start this conversation."),
      ).resolves.toMatchObject({ status: "completed" });
      const sibling = await old.request("thread/start", {});
      const closed = createDeferred<void>();
      const stopWatching = old.addNotificationHandler((notification) => {
        if (
          notification.method === "thread/closed" &&
          isJsonObject(notification.params) &&
          notification.params.threadId === target.threadId
        ) {
          closed.resolve();
        }
      });
      try {
        await old.request("thread/unsubscribe", { threadId: target.threadId });
        await racePromiseWithAbortSignal(closed.promise, common.signal);
      } finally {
        stopWatching();
      }
      expect(wasCodexAppServerThreadClosed(old, target.threadId)).toBe(false);
      ensureCodexAppServerClientRuntime(old, { agentDir: params.agentDir });
      const entry = getOrCreateSharedClientEntry(shared, "native-missed-closure");
      entry.client = old;
      shared.liveClients.add(old);
      shared.entriesByClient.set(old, entry);
      releaseSibling = retainSharedClientEntry(entry);
      expect(retireSharedCodexAppServerClientIfCurrent(old)).toMatchObject({
        activeLeases: 1,
        closed: false,
      });
      const resumed = await startOrResumeThread({ ...common, client: successor });
      expect(resumed).toMatchObject({
        threadId: target.threadId,
        lifecycle: { action: "resumed" },
      });
      await expect(
        runNativeTurn(successor, resumed.threadId, "Continue after reload."),
      ).resolves.toMatchObject({ status: "completed" });
      expect(old.getCloseError()).toBeUndefined();

      // A real loaded sibling must not become eligible merely because the process retired.
      const readCompleted = createDeferred<void>();
      const request = old.request.bind(old);
      vi.spyOn(old, "request").mockImplementation(async (method, input, options) => {
        const result = await request(method, input, options);
        if (method === "thread/read") {
          readCompleted.resolve();
        }
        return result;
      });
      const stop = new AbortController();
      let settled = false;
      const fenced = releaseCodexBoundLiveThread({
        client: successor,
        clientId: successor.getInstanceId(),
        ownerClientId: old.getInstanceId(),
        threadId: sibling.thread.id,
        lifecycleTiming: createCodexThreadLifecycleTimingTracker(false),
        signal: stop.signal,
      }).finally(() => {
        settled = true;
      });
      void fenced.catch(() => {});
      try {
        await racePromiseWithAbortSignal(readCompleted.promise, common.signal);
        await expect(
          runNativeTurn(old, sibling.thread.id, "Keep the sibling usable while handoff waits."),
        ).resolves.toMatchObject({ status: "completed" });
        expect(settled).toBe(false);
        const cancelled = new Error("Stop only the waiting handoff");
        stop.abort(cancelled);
        await expect(fenced).rejects.toBe(cancelled);
        expect(old.getCloseError()).toBeUndefined();
        expect(providerRequests).toBe(3);
      } finally {
        stop.abort();
        await Promise.allSettled([fenced]);
      }
    } finally {
      releaseSibling?.();
      expect(await old.closeAndWait()).toMatchObject({ exited: true });
      expect(await successor.closeAndWait()).toMatchObject({ exited: true });
      shared.liveClients.delete(old);
      shared.entriesByClient.delete(old);
    }
  },
);
