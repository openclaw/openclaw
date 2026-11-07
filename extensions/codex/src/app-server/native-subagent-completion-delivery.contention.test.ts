import assert from "node:assert/strict";
import path from "node:path";
import { createRequiredExecRuntimeContract } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { patchSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import { isCodexAppServerLiveThreadProtected } from "./client-runtime.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { prepareCodexNativeExecutionPolicy } from "./native-execution-policy.js";
import { fixture } from "./native-subagent-inventory.test-support.js";
import { captureCodexNativeCompletionCatalog } from "./native-subagent-monitor-runtime.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  childTurnCompletedNotification,
  createClient,
  nativeCompletionNotification,
} from "./native-subagent-monitor.test-support.js";
import { loadCodexAttemptNativeToolCatalog } from "./native-tool-catalog.js";
import { buildCodexAppServerRuntimeFingerprint } from "./plugin-app-cache-key.js";
import { setupRunAttemptTestHooks, tempDir } from "./run-attempt-test-harness.js";
import * as sharedClientLifecycle from "./shared-client-lifecycle.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";
import {
  createAppServerOptions,
  writeNativeCatalogFixture,
} from "./thread-lifecycle.test-fixtures.js";

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());

const result = "Keep the accepted native result.";
const completedChild = () =>
  childTurnCompletedNotification({
    status: "completed",
    items: [{ type: "agentMessage", id: "final", phase: "final_answer", text: result }],
  });

describe("native completion durable receipts", () => {
  setupRunAttemptTestHooks();
  it("settles a receipt received during queued retirement without an undelivered note", async () => {
    const f = await fixture();
    const client = createClient();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const mutate = f.store.mutate.bind(f.store);
    vi.spyOn(f.store, "mutate").mockImplementation(async (...args) => {
      const mutation = args[1];
      if (mutation.kind === "consume-native-subagent-assignment" && mutation.undelivered) {
        entered.resolve();
        await release.promise;
      }
      return await mutate(...args);
    });
    f.deliver.mockResolvedValue({ delivered: false, path: "none", recoveryBlocked: true });
    const parent = await f.register(client);
    let observer: Awaited<ReturnType<typeof f.register>> | undefined;
    let retirement: Promise<void> | undefined;
    try {
      await parent.ready;
      parent.bindTurn("parent-turn");
      await f.spawn(client);
      await client.notify(completedChild());
      retirement = parent.unregister();
      await entered.promise;
      observer = await f.register(client);
      observer.bindTurn("observer-turn");
      await client.notify(nativeCompletionNotification({ turnId: "observer-turn", result }));
      release.resolve();
      // Restoration drains the retirement write, so release the test gate before awaiting it.
      await observer.ready;
      await retirement;
      await observer.unregister();
      expect(await f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual(
        [],
      );
      expect(await readVisibleSessionTranscriptMessageEntries(f.identity)).toEqual([]);
      expect(f.deliver).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await retirement;
      await observer?.unregister();
      await parent.unregister();
      client.close();
    }
  });

  it("keeps a durable delivery receipt when its next ownership read fails", async () => {
    const f = await fixture();
    const client = createClient();
    const read = f.store.read.bind(f.store);
    let failNextRead = false;
    let failedReads = 0;
    vi.spyOn(f.store, "read").mockImplementation((identity) => {
      if (failNextRead) {
        failNextRead = false;
        failedReads += 1;
        throw new Error("ownership read unavailable after delivery");
      }
      return read(identity);
    });
    const mutate = f.store.mutate.bind(f.store);
    const writes: Promise<boolean>[] = [];
    const mutations = vi.spyOn(f.store, "mutate").mockImplementation((...args) => {
      const write = mutate(...args);
      writes.push(write);
      return write;
    });
    f.deliver.mockImplementation(async ({ completionCustody }) => {
      assert(completionCustody?.isCurrent());
      failNextRead = true;
      return { delivered: true, path: "direct" };
    });
    const parent = await f.register(client);
    try {
      await parent.ready;
      parent.bindTurn("parent-turn");
      await f.spawn(client);
      await parent.unregister();
      await client.notify(completedChild());
      expect(failedReads).toBe(1);
      expect(f.deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ result }));
      expect(
        mutations.mock.calls.filter(
          ([, mutation]) => mutation.kind === "consume-native-subagent-assignment",
        ),
      ).toHaveLength(1);
      await Promise.all(writes);
      expect(await f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual(
        [],
      );
      client.close();
      const replacement = await f.register(createClient());
      await replacement.ready;
      await replacement.unregister();
      expect(f.deliver).toHaveBeenCalledOnce();
    } finally {
      failNextRead = false;
      await parent.unregister();
      client.close();
      await Promise.allSettled(writes);
    }
  });
});

describe("native completion settlement", () => {
  setupRunAttemptTestHooks();
  it.each(["receipt", "retired-turn-receipt", "retirement"] as const)(
    "rechecks %s while completion delivery is in flight",
    async (change) => {
      const f = await fixture();
      const client = createClient();
      const entered = createDeferred<void>();
      const delivery = createDeferred<{ delivered: false; path: "none" }>();
      f.deliver.mockImplementationOnce(async () => {
        entered.resolve();
        return await delivery.promise;
      });
      const releasePin = vi.fn();
      const parent = await f.register(client, undefined, undefined, undefined, {
        retainParentThread: () => releasePin,
      });
      let observer: Awaited<ReturnType<typeof f.register>> | undefined;
      let completion: Promise<void> | undefined;
      let retirement: Promise<void> | undefined;
      try {
        await parent.ready;
        parent.bindTurn("parent-turn");
        await f.spawn(client);
        await parent.unregister();
        expect(releasePin).not.toHaveBeenCalled();
        completion = client.notify(completedChild());
        await entered.promise;
        // Terminal work releases execution protection while its result still owns delivery.
        expect(releasePin).toHaveBeenCalledOnce();
        expect(f.deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ result }));
        const pending = f.deliver.mock.calls[0]?.[0];
        assert(pending);
        assert(pending.completionCustody?.isCurrent());
        const catalogRequest = {
          client: client.client,
          parentThreadId: "parent-thread",
          requesterSessionKey: f.identity.sessionKey,
          sourceSessionKey: pending.childSessionKey,
          runId: `announce:${pending.announceId}`,
        };
        const capture = captureCodexNativeCompletionCatalog(catalogRequest);
        expect(capture).toBeTypeOf("function");
        expect(capture).not.toThrow();
        for (const key of [
          "parentThreadId",
          "requesterSessionKey",
          "sourceSessionKey",
          "runId",
        ] as const) {
          expect(
            captureCodexNativeCompletionCatalog({
              ...catalogRequest,
              [key]: "unrelated",
            }),
          ).toBeUndefined();
        }
        const canAdmit = pending.isSourceSessionAdmissionAllowed;
        expect(canAdmit?.()).toBe(true);
        if (change === "retirement") {
          retirement = codexNativeSubagentMonitorRuntime.retireParent(
            client.client,
            "parent-thread",
          );
          expect(canAdmit?.()).toBe(false);
          expect(capture).toThrow("Native completion catalog is no longer current");
        } else {
          observer = await f.register(client);
          await observer.ready;
          observer.bindTurn("observer-turn");
          expect(observer.listPendingChildren()).toMatchObject([{ state: "completing" }]);
          await client.notify(
            nativeCompletionNotification({
              turnId: change === "receipt" ? "observer-turn" : "parent-turn",
              result,
            }),
          );
          // A receipt cannot revoke admission while its accepted handoff is in flight.
          expect(canAdmit?.()).toBe(true);
          expect(capture).not.toThrow();
          expect(releasePin).toHaveBeenCalledOnce();
        }
        delivery.resolve({ delivered: false, path: "none" });
        await completion;
        await retirement;
        expect(f.deliver).toHaveBeenCalledOnce();
        expect(capture).toThrow("Native completion catalog is no longer current");
        expect(captureCodexNativeCompletionCatalog(catalogRequest)).toBeUndefined();
        if (change === "retired-turn-receipt") {
          expect(releasePin).toHaveBeenCalledOnce();
          expect(canAdmit?.()).toBe(true);
          expect(observer?.listPendingChildren()).toMatchObject([{ state: "completing" }]);
          expect(vi.getTimerCount()).toBe(1);
          await observer?.unregister();
          await vi.advanceTimersByTimeAsync(5_000);
          expect(f.deliver).toHaveBeenCalledTimes(2);
          expect(f.deliver).toHaveBeenLastCalledWith(expect.objectContaining({ result }));
        }
        expect(canAdmit?.()).toBe(false);
        expect(releasePin).toHaveBeenCalledOnce();
        // The production runtime also retains a pooled-client idle timer.
        client.close();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        delivery.resolve({ delivered: false, path: "none" });
        await completion;
        await codexNativeSubagentMonitorRuntime.retireParent(client.client, "parent-thread");
        await observer?.unregister();
        await parent.unregister();
        client.close();
        vi.useRealTimers();
      }
    },
  );
});

describe("native completion catalog execution authority", () => {
  setupRunAttemptTestHooks();
  it.each(["unavailable executor", "session reassigned"] as const)(
    "rejects a native exec call after recovering declarations: %s",
    async (change) => {
      const f = await fixture();
      const client = createClient();
      const command = createRequiredExecRuntimeContract();
      const signal = new AbortController().signal;
      const declarations = createCodexDynamicToolBridge({
        tools: [command.tool],
        signal,
        loading: "direct",
      }).specs;
      const agentDir = path.join(tempDir, "catalog-execution");
      const codexHome = resolveCodexAppServerHomeDir(agentDir);
      const rolloutPath = path.join(codexHome, "sessions", "parent.jsonl");
      await writeNativeCatalogFixture(rolloutPath, "parent-thread", declarations);
      const appServer = createAppServerOptions();
      const serverVersion = client.client.getServerVersion();
      assert(serverVersion, "The native fixture must report its server version");
      const runtimeIdentity = { serverVersion, codexHome };
      vi.spyOn(client.client, "getRuntimeIdentity").mockReturnValue(runtimeIdentity);
      vi.spyOn(
        sharedClientLifecycle,
        "retainSharedCodexAppServerClientByInstanceId",
      ).mockResolvedValue({ client: client.client, release: vi.fn() });
      const policy = await prepareCodexNativeExecutionPolicy({
        agentId: f.identity.agentId,
        sessionKey: f.identity.sessionKey,
        config: {},
        readRuntimeSessionEntry: true,
        sandboxAvailable: false,
      });
      const parent = await f.register(client);
      let checked = false;
      let recoveredCatalog: Awaited<ReturnType<typeof loadCodexAttemptNativeToolCatalog>>;
      f.deliver.mockImplementationOnce(async (request) => {
        assert(request.completionCustody?.isCurrent());
        expect(isCodexAppServerLiveThreadProtected(client.client, "parent-thread")).toBe(false);
        const recovered = await loadCodexAttemptNativeToolCatalog({
          binding: {
            threadId: "parent-thread",
            cwd: tempDir,
            rolloutPath,
            clientId: client.client.getInstanceId(),
            dynamicToolsFingerprint: codexDynamicToolsFingerprint(declarations),
            appServerRuntimeFingerprint: buildCodexAppServerRuntimeFingerprint({
              appServer,
              appServerVersion: client.client.getServerVersion(),
              runtimeIdentity,
            }),
          },
          completion: {
            requesterSessionKey: f.identity.sessionKey,
            sourceSessionKey: request.childSessionKey,
            runId: `announce:${request.announceId}`,
          },
          appServer,
          agentDir,
          signal,
          authority: parent.bindingAuthority,
          assertCurrent: () => {},
          acquireClient: async () => client.client,
          releaseClient: () => {},
        });
        recoveredCatalog = recovered;
        expect(recovered).toEqual(declarations);
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const bridge = createCodexDynamicToolBridge({
          tools: change === "unavailable executor" ? [] : [command.tool],
          registeredSpecs: recovered,
          requireExactRegisteredDefinitions: true,
          signal,
          loading: "direct",
          assertCurrentAsync: async () => {
            entered.resolve();
            await release.promise;
            await policy.assertCurrent();
          },
        });
        const response = bridge.handleToolCall({
          threadId: "parent-thread",
          turnId: "completion-turn",
          callId: "native-exec",
          namespace: null,
          tool: "exec",
          arguments: { command: "echo forbidden", workdir: tempDir, awaitResults: true },
        });
        try {
          if (change === "session reassigned") {
            await entered.promise;
            expect(command.spawn).not.toHaveBeenCalled();
            await patchSessionEntry({
              agentId: f.identity.agentId,
              sessionKey: f.identity.sessionKey,
              storePath: resolveStorePath(undefined, { agentId: f.identity.agentId }),
              update: () => ({ sessionId: "replacement" }),
              skipMaintenance: true,
            });
            expect(request.completionCustody?.isCurrent()).toBe(false);
          }
        } finally {
          release.resolve();
        }
        expect(await response).toMatchObject({
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: expect.stringContaining(
                change === "unavailable executor"
                  ? "not available for this turn"
                  : "execution policy changed",
              ),
            },
          ],
        });
        expect(command.spawn).not.toHaveBeenCalled();
        checked = true;
        return { delivered: true, path: "direct" };
      });
      try {
        await parent.ready;
        parent.bindTurn("parent-turn");
        await f.spawn(client);
        await parent.unregister();
        await client.notify(completedChild());
        expect(f.deliver).toHaveBeenCalledOnce();
        expect(recoveredCatalog).toEqual(declarations);
        expect(checked).toBe(true);
      } finally {
        policy.release();
        command.close();
        client.close();
        await parent.unregister();
      }
    },
  );
});
