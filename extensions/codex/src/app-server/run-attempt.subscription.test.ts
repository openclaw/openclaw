import path from "node:path";
import type { HarnessContextEngine as ContextEngine } from "openclaw/plugin-sdk/agent-harness-runtime";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { patchSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  claimCodexAppServerLiveThread,
  consumeCodexAppServerLiveThread,
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
} from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import { ownCodexInferenceClient } from "./inference-routing.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import * as runAttemptResources from "./run-attempt-resources.js";
import { seedRunSessionOwnerForTest } from "./run-attempt-session-owners.test-support.js";
import type { StartedCodexAttemptResources } from "./run-attempt-start.js";
import {
  assistantMessage,
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
  userMessage,
} from "./run-attempt-test-harness.js";
import * as runAttemptTurnRequest from "./run-attempt-turn-request.js";
import {
  createContextEngine,
  DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
  requestMethodsExcludingSkillDiscovery,
} from "./run-attempt.context-engine.test-support.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { getCurrentSharedClientEntry } from "./shared-client-lifecycle.js";
import type { CodexAppServerThreadLifecycleBinding } from "./thread-lifecycle-types.js";
import * as threadOwnership from "./thread-ownership.js";
import type { CodexAppServerTurnRouter } from "./turn-router.js";

setupRunAttemptTestHooks();

function captureResources() {
  const captured =
    createDeferred<ReturnType<typeof runAttemptResources.prepareCodexAttemptResources>>();
  const prepare = runAttemptResources.prepareCodexAttemptResources;
  const spy = vi
    .spyOn(runAttemptResources, "prepareCodexAttemptResources")
    .mockImplementationOnce((prompt) => {
      const resources = prepare(prompt);
      captured.resolve(resources);
      return resources;
    });
  return { captured: captured.promise, spy };
}

function requestsFor(harness: ReturnType<typeof createStartedThreadHarness>, method: string) {
  return harness.requests.filter((request) => request.method === method);
}

const workspace = () => path.join(tempDir, "workspace");
const sessionParams = (name: string) => createParams(path.join(tempDir, `${name}.jsonl`), tempDir);
const complete = (harness: ReturnType<typeof createStartedThreadHarness>) =>
  harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });

describe("Codex attempt subscription recovery", () => {
  it("requires startup before a prepared attempt can supply live resources", () => {
    type Prepared = ReturnType<typeof runAttemptResources.prepareCodexAttemptResources>;
    expectTypeOf<Prepared["state"]["client"]>().toEqualTypeOf<CodexAppServerClient | undefined>();
    expectTypeOf<Prepared["state"]["thread"]>().toEqualTypeOf<
      CodexAppServerThreadLifecycleBinding | undefined
    >();
    expectTypeOf<Prepared["state"]["turnRouter"]>().toEqualTypeOf<
      CodexAppServerTurnRouter | undefined
    >();
    expectTypeOf<Prepared>().not.toMatchTypeOf<StartedCodexAttemptResources>();
    expectTypeOf<
      StartedCodexAttemptResources["state"]["client"]
    >().toEqualTypeOf<CodexAppServerClient>();
    expectTypeOf<
      StartedCodexAttemptResources["state"]["thread"]
    >().toEqualTypeOf<CodexAppServerThreadLifecycleBinding>();
    expectTypeOf<
      StartedCodexAttemptResources["state"]["turnRouter"]
    >().toEqualTypeOf<CodexAppServerTurnRouter>();
  });

  it("reports an unavailable binding reader before admitting a native turn", async () => {
    const prepare = runAttemptResources.prepareCodexAttemptResources;
    vi.spyOn(runAttemptResources, "prepareCodexAttemptResources").mockImplementationOnce(
      (prompt) => {
        const resources = prepare(prompt);
        vi.spyOn(
          prompt.context.runtime.connection.bindingStore,
          "prepareRead",
        ).mockResolvedValueOnce(undefined);
        return resources;
      },
    );
    const register = vi.spyOn(codexNativeSubagentMonitorRuntime, "register");
    const harness = createStartedThreadHarness();
    const params = sessionParams("unavailable-reader");

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow(
      "Codex native subagent binding reader is unavailable",
    );
    expect(register).not.toHaveBeenCalled();
    expect(requestsFor(harness, "turn/start")).toEqual([]);
  });

  it("declines optional subscription retention when its binding reader is unavailable", async () => {
    const { captured } = captureResources();
    const harness = createStartedThreadHarness();
    const params = sessionParams("unavailable-retention");
    const run = runCodexAppServerAttempt(params);
    await run.waitForTurnAccepted();
    const resources = await captured;
    const prepareRead = vi
      .spyOn(resources.prompt.context.runtime.connection.bindingStore, "prepareRead")
      .mockResolvedValueOnce(undefined);
    const publish = vi.spyOn(threadOwnership, "retainCodexAppServerBindingSubscription");
    try {
      await expect(resources.retainThreadSubscription()).resolves.toBe(false);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      prepareRead.mockRestore();
      await complete(harness);
      await run;
    }
  });

  it("revokes native submission custody when an unstamped parent session is replaced", async () => {
    // Worker preparation must not race this authority check's execution deadline.
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const params = sessionParams("unstamped-parent");
    const target = {
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey!,
      storePath: resolveStorePath(undefined, { agentId: "main" }),
    };
    params.sessionTarget = target;
    const register = vi.spyOn(codexNativeSubagentMonitorRuntime, "register");
    const harness = createStartedThreadHarness();
    const attempt = runCodexAppServerAttempt(params);
    const settledAttempt = attempt.then(
      (result) => result,
      (error: unknown) => error,
    );
    await attempt.waitForTurnAccepted();
    try {
      const registration = register.mock.calls.at(-1)?.[0];
      expect(registration?.historyOwner).toBeDefined();
      expect(registration?.historyOwner?.lifecycleRevision).toBeUndefined();
      const submission = registration?.submissionStore;
      expect(submission).toBeDefined();
      await submission!.assertCurrentAsync();
      await patchSessionEntry({
        ...target,
        update: () => ({ sessionId: "replacement-parent" }),
      });
      await expect(submission!.assertCurrentAsync()).rejects.toThrow(
        "Native submission session lifecycle is no longer current.",
      );
    } finally {
      await complete(harness);
      await settledAttempt;
    }
    expect(await settledAttempt).toMatchObject({
      message: `Codex session generation is no longer current: ${target.sessionId}`,
    });
  });

  it("continues a confirmed interrupted thread while a sibling turn stays active", async () => {
    const workspaceDir = workspace();
    const sessionFile = path.join(tempDir, "interrupted.jsonl");
    const abort = new AbortController();
    const params = createParams(sessionFile, workspaceDir);
    params.abortSignal = abort.signal;
    const siblingParams = createParams(path.join(tempDir, "sibling.jsonl"), workspaceDir, {
      sessionId: "session-sibling",
      sessionKey: "agent:main:sibling",
      runId: "run-sibling",
    });
    await seedRunSessionOwnerForTest(siblingParams.sessionId, siblingParams.sessionKey!);
    let starts = 0;
    let turns = 0;
    const harness = createStartedThreadHarness(
      async (method) => {
        if (method === "account/read") {
          return { account: { type: "apiKey" } };
        }
        if (method === "thread/start") {
          return threadStartResult(++starts === 1 ? "thread-1" : "thread-sibling");
        }
        if (method === "thread/resume") {
          return threadStartResult("thread-1");
        }
        if (method === "turn/start") {
          return turnStartResult(`turn-${++turns}`);
        }
        return undefined;
      },
      { persistedThreads: [] },
    );
    ownCodexInferenceClient(harness.client);
    const first = runCodexAppServerAttempt(params);
    await first.waitForTurnAccepted();
    const sibling = runCodexAppServerAttempt(siblingParams);
    const siblingSettled = vi.fn();
    void sibling.then(siblingSettled, siblingSettled);
    await sibling.waitForTurnAccepted();
    let next: ReturnType<typeof runCodexAppServerAttempt> | undefined;
    try {
      abort.abort("interrupted");
      await harness.waitForMethod("turn/interrupt");
      await harness.notify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "interrupted", items: [] },
        },
      });
      expect(readAttemptTerminal(await first).aborted).toBe(true);
      expect(requestsFor(harness, "thread/unsubscribe")).toEqual([
        { method: "thread/unsubscribe", params: { threadId: "thread-1" } },
      ]);
      expect(getCurrentSharedClientEntry(harness.client)).toBeDefined();
      expect(siblingSettled).not.toHaveBeenCalled();

      next = runCodexAppServerAttempt(
        createParams(sessionFile, workspaceDir, { runId: "run-next" }),
      );
      await next.waitForTurnAccepted();
      expect(siblingSettled).not.toHaveBeenCalled();
      expect(starts).toBe(2);
      expect(requestsFor(harness, "thread/resume")).toEqual([
        { method: "thread/resume", params: expect.objectContaining({ threadId: "thread-1" }) },
      ]);
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-3" });
      expect((await next).terminal).toEqual({ kind: "ok" });
    } finally {
      await harness.completeTurn({ threadId: "thread-sibling", turnId: "turn-2" });
      await Promise.allSettled([first, sibling, next]);
    }
    expect((await sibling).terminal).toEqual({ kind: "ok" });
  });

  it.each<{
    failureAt: "monitor" | "turn request";
    revoked?: "abort" | "host" | "binding" | "closed" | "expired" | "successor";
  }>([
    { failureAt: "turn request" },
    { failureAt: "monitor", revoked: "abort" },
    { failureAt: "monitor", revoked: "host" },
    { failureAt: "monitor", revoked: "binding" },
    { failureAt: "monitor", revoked: "closed" },
    { failureAt: "monitor", revoked: "expired" },
    { failureAt: "monitor", revoked: "successor" },
  ])(
    "settles a native warm claim after $failureAt failure (revoked: $revoked)",
    async ({ failureAt, revoked }) => {
      const sessionFile = path.join(tempDir, "subscription-session.jsonl");
      const workspaceDir = workspace();
      const threadId = "thread-1";
      const params = createParams(sessionFile, workspaceDir);
      const abortController = new AbortController();
      params.abortSignal = abortController.signal;
      let hostRevoked = false;
      let expiredRetentionAttempted = false;
      const originalHost = params.hostCapabilities;
      params.hostCapabilities = {
        ...originalHost,
        assertActive: () => {
          if (hostRevoked) {
            throw new Error("host generation revoked");
          }
          originalHost.assertActive();
        },
      };
      const native = threadStartResult(threadId);
      await writeCodexAppServerBinding(sessionFile, {
        threadId,
        cwd: workspaceDir,
        dynamicToolsFingerprint: "[]",
        preserveNativeModel: true,
        webSearchThreadConfigFingerprint: DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
        model: native.model,
        modelProvider: native.modelProvider,
      });
      let turnCount = 0;
      const harness = createStartedThreadHarness(
        async (method) => {
          if (method === "thread/resume") {
            return threadStartResult(threadId);
          }
          if (method === "turn/start") {
            turnCount += 1;
            return turnStartResult("turn-" + turnCount);
          }
          return undefined;
        },
        { persistedThreads: [threadId] },
      );
      const first = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await complete(harness);
      await first;
      const originalBinding = await readCodexAppServerBinding(sessionFile);
      expect(originalBinding).toMatchObject({
        threadId,
        preserveNativeModel: true,
      });
      harness.requests.length = 0;

      const failure = new Error("pre-turn resource setup failed");
      const prepareResources = runAttemptResources.prepareCodexAttemptResources;
      const resourcesSpy = vi
        .spyOn(runAttemptResources, "prepareCodexAttemptResources")
        .mockImplementationOnce((prompt) => {
          const resources = prepareResources(prompt);
          if (failureAt === "monitor") {
            vi.spyOn(resources, "registerNativeSubagentMonitor").mockImplementationOnce(
              async () => {
                if (revoked === "abort") {
                  abortController.abort(new Error("canceled during monitor setup"));
                } else if (revoked === "host") {
                  hostRevoked = true;
                } else if (revoked === "binding") {
                  await writeCodexAppServerBinding(sessionFile, {
                    ...originalBinding!,
                    threadId: "replacement-thread",
                  });
                } else if (revoked === "expired") {
                  resources.state.nativeSettlementExpired = true;
                  // No optional retention may enter a lease or durable row read.
                  vi.spyOn(
                    prompt.context.runtime.connection.bindingStore,
                    "withLease",
                  ).mockImplementationOnce(async () => {
                    expiredRetentionAttempted = true;
                    throw new Error("expired cleanup queued optional retention");
                  });
                } else if (revoked === "successor") {
                  const thread = resources.state.thread;
                  if (!thread) {
                    throw new Error("Expected the adopted thread during monitor setup");
                  }
                  thread.liveThreadOwnership?.forget();
                  await claimCodexAppServerLiveThread(harness.client, threadId);
                  hostRevoked = true;
                } else if (revoked === "closed") {
                  await harness.notify({ method: "thread/closed", params: { threadId } });
                }
                throw failure;
              },
            );
          }
          return resources;
        });
      const turnRequestSpy =
        failureAt === "turn request"
          ? vi
              .spyOn(runAttemptTurnRequest, "prepareCodexAttemptTurnRequest")
              .mockRejectedValueOnce(failure)
          : undefined;
      await expect(runCodexAppServerAttempt({ ...params, runId: "run-failed" })).rejects.toBe(
        failure,
      );
      resourcesSpy.mockRestore();
      turnRequestSpy?.mockRestore();
      expect(requestsFor(harness, "turn/start")).toEqual([]);
      expect(isCodexAppServerLiveThreadClaimed(harness.client, threadId)).toBe(
        revoked === "successor",
      );
      expect(harness.client.getCloseError()).toBeUndefined();
      expect(expiredRetentionAttempted).toBe(false);
      if (revoked) {
        expect(hasCodexAppServerLiveThread(harness.client, threadId)).toBe(revoked === "successor");
        expect(requestsFor(harness, "thread/unsubscribe")).toHaveLength(
          revoked === "closed" || revoked === "successor" ? 0 : 1,
        );
        expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
          threadId: revoked === "binding" ? "replacement-thread" : threadId,
        });
        return;
      }
      expect(
        harness.requests.some(
          ({ method }) => method === "thread/resume" || method === "thread/unsubscribe",
        ),
      ).toBe(false);
      expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
        threadId,
        clientId: originalBinding?.clientId,
      });

      const retry = runCodexAppServerAttempt({ ...params, runId: "run-retry" });
      await retry.waitForTurnAccepted();
      expect(turnCount).toBe(2);
      await harness.completeTurn({ threadId, turnId: "turn-2" });
      await retry;
      expect(
        harness.requests.some(
          ({ method }) => method === "thread/resume" || method === "thread/unsubscribe",
        ),
      ).toBe(false);
      expect(isCodexAppServerLiveThreadClaimed(harness.client, threadId)).toBe(false);
    },
  );
  it.each(["after publication", "before publication with new native custody"] as const)(
    "recovers subscription custody when row admission fails %s",
    async (failureAt) => {
      const { captured, spy: capture } = captureResources();
      const harness = createStartedThreadHarness();
      const params = createParams(path.join(tempDir, "custody.jsonl"), workspace());
      const run = runCodexAppServerAttempt(params);
      const resources = await Promise.race([
        captured,
        run.then(() => {
          throw new Error("Attempt ended before preparation");
        }),
      ]);
      await run.waitForTurnAccepted();
      const { connection } = resources.prompt.context.runtime;
      const thread = resources.state.thread;
      if (!thread) {
        throw new Error("Expected the adopted thread after startup");
      }
      const { threadId } = thread;
      const rowFailure = new Error("row reader release failed");
      const rowWaiting = createDeferred<void>();
      const releaseRow = createDeferred<void>();
      const withCurrent = connection.withCurrent;
      const admission = vi
        .spyOn(connection, "withCurrent")
        .mockImplementationOnce(async (consume) => {
          if (failureAt === "after publication") {
            await withCurrent(consume);
          } else {
            rowWaiting.resolve();
            await releaseRow.promise;
          }
          throw rowFailure;
        });
      const publication = vi.spyOn(threadOwnership, "retainCodexAppServerBindingSubscription");
      try {
        const retention = resources.retainThreadSubscription();
        if (failureAt === "after publication") {
          await expect(retention).rejects.toBe(rowFailure);
        } else {
          await rowWaiting.promise;
          const authority = resources.nativeProcessAuthority!;
          expect(authority.hasCurrentProcesses(harness.client, threadId)).toBe(false);
          // Native inventory arrives while foreground row admission is waiting.
          // Its real owner must survive that reader's failure and publish under
          // fresh cleanup admission, without replaying a started publication.
          const confirm = authority.prepareBackgroundCommands(
            harness.client,
            { threadId, turnId: "turn-1" },
            new Map([["background-item", "process-1"]]),
          );
          confirm(new Map([["background-item", "process-1"]]));
          expect(authority.hasCurrentProcesses(harness.client, threadId)).toBe(true);
          releaseRow.resolve();
          await expect(retention).resolves.toBe(true);
          await expect(resources.retainThreadSubscription()).resolves.toBe(true);
        }
        expect(publication).toHaveBeenCalledOnce();
        expect(hasCodexAppServerLiveThread(harness.client, threadId)).toBe(true);
        expect(requestsFor(harness, "thread/unsubscribe")).toEqual([]);
      } finally {
        admission.mockRestore();
        publication.mockRestore();
        capture.mockRestore();
        resources.state.nativeSettlementExpired = true;
        await harness.completeTurn({ threadId, turnId: "turn-1" });
        await run;
        if (failureAt !== "after publication") {
          await harness.notify({ method: "thread/closed", params: { threadId } });
        }
      }
    },
  );

  it.each([false, true])(
    "preserves native ownership through terminal overflow (expected native: %s)",
    async (nativeOwned) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = workspace();
      openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-1" }).appendMessage(
        assistantMessage("pre-compaction context", Date.now()) as never,
      );
      const nativeModel = threadStartResult("thread-old");
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-old",
        cwd: workspaceDir,
        dynamicToolsFingerprint: "[]",
        webSearchThreadConfigFingerprint: DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
        ...(nativeOwned
          ? {
              preserveNativeModel: true,
              model: nativeModel.model,
              modelProvider: nativeModel.modelProvider,
            }
          : {}),
        contextEngine: {
          schemaVersion: 1,
          engineId: "lossless-claw",
          policyFingerprint:
            '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}',
          projection: {
            schemaVersion: 1,
            mode: "thread_bootstrap",
            epoch: "epoch-before",
          },
        },
      });
      const compact = vi.fn<ContextEngine["compact"]>(async () => ({
        ok: true,
        compacted: true,
        result: { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 100_000 },
      }));
      const assemble = vi.fn(
        async ({ messages, prompt }: Parameters<ContextEngine["assemble"]>[0]) => ({
          messages: [...messages, userMessage(prompt ?? "", 11)],
          estimatedTokens: 42,
          systemPromptAddition: "context-engine system",
          contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-before" },
        }),
      );
      const contextEngine = createContextEngine({ assemble, compact });
      const harness = createStartedThreadHarness(
        async (method) => {
          if (method === "thread/resume") {
            return threadStartResult("thread-old");
          }
          if (method === "turn/start") {
            return turnStartResult("turn-old");
          }
          return undefined;
        },
        { persistedThreads: ["thread-old"] },
      );
      const params = createParams(sessionFile, workspaceDir);
      delete params.contextWindowInfo;
      delete params.observeToolTerminal;
      params.contextEngine = contextEngine;
      params.contextTokenBudget = 400_000;
      if (nativeOwned) {
        params.expectedSessionRuntimeOwnership = {
          model: "native",
          auth: "host",
          modelRef: { model: nativeModel.model, provider: nativeModel.modelProvider },
        };
      }

      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await harness.notify({
        method: "turn/completed",
        params: {
          threadId: "thread-old",
          turnId: "turn-old",
          turn: {
            id: "turn-old",
            status: "failed",
            error: { message: "Codex ran out of room in the model's context window" },
            items: [],
          },
        },
      });
      const result = await run;

      expect(readAttemptTerminal(result).promptError).toBe(
        "Codex ran out of room in the model's context window",
      );
      expect(compact).not.toHaveBeenCalled();
      expect(requestMethodsExcludingSkillDiscovery(harness)).toEqual([
        "configRequirements/read",
        "config/read",
        "configRequirements/read",
        "thread/read",
        "thread/resume",
        "thread/inject_items",
        "turn/start",
        ...(!nativeOwned ? ["thread/unsubscribe"] : []),
      ]);
      const savedBinding = await readCodexAppServerBinding(sessionFile);
      if (nativeOwned) {
        expect(savedBinding).toMatchObject({ threadId: "thread-old", preserveNativeModel: true });
        const ownership = await consumeCodexAppServerLiveThread(harness.client, "thread-old");
        expect(ownership?.configFingerprint).toBeDefined();
        expect(() => ownership?.assertCurrent()).not.toThrow();
        await ownership?.release("thread-old");
      } else {
        expect(savedBinding).toBeUndefined();
      }
    },
  );
});
