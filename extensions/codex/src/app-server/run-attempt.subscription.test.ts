import path from "node:path";
import type { HarnessContextEngine as ContextEngine } from "openclaw/plugin-sdk/agent-harness-runtime";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  claimCodexAppServerLiveThread,
  consumeCodexAppServerLiveThread,
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
} from "./client-runtime.js";
import * as runAttemptResources from "./run-attempt-resources.js";
import { seedRunSessionOwnerForTest } from "./run-attempt-session-owners.test-support.js";
import {
  assistantMessage,
  createParams,
  createStartedThreadHarness,
  fastWait,
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
  requestMethodsExcludingSkillDiscovery,
} from "./run-attempt.context-engine.test-support.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { getCurrentSharedClientEntry } from "./shared-client-lifecycle.js";
import * as threadOwnership from "./thread-ownership.js";

setupRunAttemptTestHooks();

describe("Codex attempt subscription recovery", () => {
  it("continues a confirmed interrupted thread while a sibling turn stays active", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
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
      expect(harness.requests.filter(({ method }) => method === "thread/unsubscribe")).toEqual([
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
      expect(harness.requests.filter(({ method }) => method === "thread/resume")).toEqual([
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
    nativeOwned: boolean;
    failureAt: "monitor" | "turn request";
    revoked?: "abort" | "host" | "binding" | "closed" | "expired" | "successor";
  }>([
    { nativeOwned: true, failureAt: "turn request" },
    { nativeOwned: true, failureAt: "monitor", revoked: "abort" },
    { nativeOwned: true, failureAt: "monitor", revoked: "host" },
    { nativeOwned: true, failureAt: "monitor", revoked: "binding" },
    { nativeOwned: true, failureAt: "monitor", revoked: "closed" },
    { nativeOwned: true, failureAt: "monitor", revoked: "expired" },
    { nativeOwned: true, failureAt: "monitor", revoked: "successor" },
  ])(
    "settles a warm claim after $failureAt failure (native: $nativeOwned, revoked: $revoked)",
    async ({ nativeOwned, failureAt, revoked }) => {
      const sessionFile = path.join(tempDir, "subscription-session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
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
      if (nativeOwned) {
        const native = threadStartResult(threadId);
        await writeCodexAppServerBinding(sessionFile, {
          threadId,
          cwd: workspaceDir,
          dynamicToolsFingerprint: "[]",
          preserveNativeModel: true,
          webSearchThreadConfigFingerprint: JSON.stringify({
            "features.standalone_web_search": false,
            web_search: "disabled",
          }),
          model: native.model,
          modelProvider: native.modelProvider,
        });
      }
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
        { persistedThreads: nativeOwned ? [threadId] : [] },
      );
      const first = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await harness.completeTurn({ threadId, turnId: "turn-1" });
      await first;
      const originalBinding = await readCodexAppServerBinding(sessionFile);
      expect(originalBinding).toMatchObject({
        threadId,
        ...(nativeOwned ? { preserveNativeModel: true } : {}),
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
                  resources.state.thread.liveThreadOwnership?.forget();
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
      expect(harness.requests.some(({ method }) => method === "turn/start")).toBe(false);
      expect(isCodexAppServerLiveThreadClaimed(harness.client, threadId)).toBe(
        revoked === "successor",
      );
      expect(harness.client.getCloseError()).toBeUndefined();
      expect(expiredRetentionAttempted).toBe(false);
      if (revoked) {
        expect(hasCodexAppServerLiveThread(harness.client, threadId)).toBe(revoked === "successor");
        expect(
          harness.requests.filter(({ method }) => method === "thread/unsubscribe"),
        ).toHaveLength(revoked === "closed" || revoked === "successor" ? 0 : 1);
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
      await vi.waitFor(() => expect(turnCount).toBe(2), fastWait);
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
  it("does not replay subscription publication when reader release fails", async () => {
    const captured =
      createDeferred<ReturnType<typeof runAttemptResources.prepareCodexAttemptResources>>();
    const prepare = runAttemptResources.prepareCodexAttemptResources;
    const capture = vi
      .spyOn(runAttemptResources, "prepareCodexAttemptResources")
      .mockImplementationOnce((prompt) => {
        const resources = prepare(prompt);
        captured.resolve(resources);
        return resources;
      });
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "custody.jsonl"),
      path.join(tempDir, "workspace"),
    );
    const run = runCodexAppServerAttempt(params);
    const resources = await Promise.race([
      captured.promise,
      run.then(() => {
        throw new Error("Attempt ended before preparation");
      }),
    ]);
    await harness.waitForMethod("turn/start");
    const { connection } = resources.prompt.context.runtime;
    const { threadId } = resources.state.thread;
    const rowFailure = new Error("row reader release failed");
    const withCurrent = connection.withCurrent;
    const admission = vi
      .spyOn(connection, "withCurrent")
      .mockImplementationOnce(async (consume) => {
        await withCurrent(consume);
        throw rowFailure;
      });
    const publication = vi.spyOn(threadOwnership, "retainCodexAppServerBindingSubscription");
    try {
      await expect(resources.retainThreadSubscription()).rejects.toBe(rowFailure);
      expect(publication).toHaveBeenCalledOnce();
      expect(hasCodexAppServerLiveThread(harness.client, threadId)).toBe(true);
      expect(harness.requests.some(({ method }) => method === "thread/unsubscribe")).toBe(false);
    } finally {
      admission.mockRestore();
      publication.mockRestore();
      capture.mockRestore();
      resources.state.nativeSettlementExpired = true;
      await harness.completeTurn({ threadId, turnId: "turn-1" });
      await run;
    }
  });

  it.each([false, true])(
    "preserves native ownership through terminal overflow (expected native: %s)",
    async (nativeOwned) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-1" }).appendMessage(
        assistantMessage("pre-compaction context", Date.now()) as never,
      );
      const nativeModel = threadStartResult("thread-old");
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-old",
        cwd: workspaceDir,
        dynamicToolsFingerprint: "[]",
        webSearchThreadConfigFingerprint: JSON.stringify({
          "features.standalone_web_search": false,
          web_search: "disabled",
        }),
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
