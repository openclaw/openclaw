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
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import {
  CodexNativeProcessAuthority,
  getCodexNativeProcessClient,
  hasCodexNativeBackgroundProcesses,
} from "./native-process-authority.js";
import * as runAttemptResources from "./run-attempt-resources.js";
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
import { createContextEngine } from "./run-attempt.context-engine.test-support.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import * as threadOwnership from "./thread-ownership.js";

setupRunAttemptTestHooks();

describe("Codex attempt subscription recovery", () => {
  it.each<{
    nativeOwned: boolean;
    failureAt: "monitor" | "turn request";
    revoked?: "abort" | "host" | "binding" | "closed" | "expired" | "successor";
  }>([
    { nativeOwned: false, failureAt: "monitor" },
    { nativeOwned: true, failureAt: "monitor" },
    { nativeOwned: false, failureAt: "turn request" },
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
  it.each(["existing custody", "row wait", "reader release"] as const)(
    "decides native custody once at publication after %s",
    async (boundary) => {
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
          throw new Error("Attempt ended before resource preparation");
        }),
      ]);
      await harness.waitForMethod("turn/start");
      const { connection } = resources.prompt.context.runtime;
      const { threadId } = resources.state.thread;
      const owner = new CodexNativeProcessAuthority(createCodexTestHostCapabilities(), () => {});
      owner.bindTurn(harness.client, threadId, "custodian-turn");
      owner.admit(
        harness.client,
        { threadId, turnId: "custodian-turn", itemId: "custodian-command" },
        () => {},
      );
      const nativeClient = getCodexNativeProcessClient(harness.client);
      let process: ReturnType<typeof nativeClient.claim> | undefined;
      const startBackground = () => {
        process = nativeClient.claim({ threadId, toolCallId: "custodian-command" }, async () => {});
      };
      if (boundary === "existing custody") {
        startBackground();
      }
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const rowFailure = new Error("row admission/release failed");
      const withCurrent = connection.withCurrent;
      const admission = vi
        .spyOn(connection, "withCurrent")
        .mockImplementationOnce(async (consume) => {
          if (boundary !== "reader release") {
            entered.resolve();
            await release.promise;
          } else {
            await withCurrent(consume);
            startBackground();
          }
          throw rowFailure;
        });
      const publication = vi.spyOn(threadOwnership, "retainCodexAppServerBindingSubscription");
      const retention = resources.retainThreadSubscription();
      try {
        if (boundary === "existing custody") {
          await expect(
            Promise.race([
              retention.then(() => "published"),
              entered.promise.then(() => "waiting"),
            ]),
          ).resolves.toBe("published");
          expect(admission).not.toHaveBeenCalled();
        } else if (boundary === "row wait") {
          await expect(
            Promise.race([
              entered.promise.then(() => "waiting"),
              retention.then(() => "published"),
            ]),
          ).resolves.toBe("waiting");
          expect(hasCodexNativeBackgroundProcesses(harness.client, threadId)).toBe(false);
          startBackground();
          release.resolve();
          await expect(retention).resolves.toBe(true);
        } else {
          await expect(retention).rejects.toBe(rowFailure);
        }
        expect(hasCodexNativeBackgroundProcesses(harness.client, threadId)).toBe(true);
        expect(publication).toHaveBeenCalledOnce();
        expect(hasCodexAppServerLiveThread(harness.client, threadId)).toBe(true);
        expect(harness.requests.some(({ method }) => method === "thread/unsubscribe")).toBe(false);
      } finally {
        release.resolve();
        await retention.catch(() => {});
        admission.mockRestore();
        publication.mockRestore();
        capture.mockRestore();
        process?.settle();
        owner.release();
        // The failed reader case already published; finish its exact resource
        // without starting a second optional retention during attempt teardown.
        resources.state.nativeSettlementExpired = true;
        await harness.completeTurn({ threadId, turnId: "turn-1" });
        await run;
      }
    },
  );

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
      expect(harness.requests.map((request) => request.method)).toEqual([
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
