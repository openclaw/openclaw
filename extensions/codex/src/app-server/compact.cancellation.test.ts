import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { patchSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { threadStartResult } from "./codex-app-server.test-fixtures.js";
import {
  compactCodexSessionWithTestHost as maybeCompactCodexAppServerSessionImpl,
  createFakeCodexCompactionClient,
  maybeCompactCodexAppServerSession,
  resetCodexAppServerClientFactoryForTest,
  writeCompactionTestBinding,
  writeSupervisedTestBinding,
} from "./compact.test-support.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import type { CodexServerNotification } from "./protocol.js";
import { resolveCodexSessionBinding } from "./session-binding.js";
import {
  createCodexTestBindingStore,
  readCodexAppServerBinding,
  resetCodexTestBindingStore,
} from "./session-binding.test-helpers.js";
import { createClientHarness } from "./test-support.js";
import { withCodexAppServerThreadMutation } from "./thread-ownership.js";

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-codex-compact-");
let tempDir: string;

function contextEngineBinding() {
  return {
    schemaVersion: 1 as const,
    engineId: "lossless-claw",
    policyFingerprint: "policy-1",
    projection: {
      schemaVersion: 1 as const,
      mode: "thread_bootstrap" as const,
      epoch: "epoch-1",
      fingerprint: "fingerprint-1",
    },
  };
}

async function createRetainedHarness(onRequest: (request: { id: number; method: string }) => void) {
  const harness = createClientHarness({
    onWrite(line, send) {
      const request = JSON.parse(line) as { id: number; method: string };
      if (request.method === "thread/unsubscribe") {
        send({ id: request.id, result: { status: "unsubscribed" } });
      } else if (request.method === "turn/interrupt") {
        send({ id: request.id, result: {} });
      } else {
        onRequest(request);
      }
    },
  });
  ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempDir });
  await retainCodexAppServerLiveThread(harness.client, "thread-1");
  return harness;
}

function compactionParams(sessionFile: string, abortSignal?: AbortSignal) {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir: tempDir,
    trigger: "manual" as const,
    abortSignal,
  };
}

function turnEvent(
  threadId: string,
  id: string,
  status: "inProgress" | "completed" | "interrupted",
): CodexServerNotification {
  return {
    method: status === "inProgress" ? "turn/started" : "turn/completed",
    params: { threadId, turn: { id, status, ...(status === "inProgress" ? {} : { items: [] }) } },
  };
}

function settleCompactionHarnessAfterAssertions(harness: ReturnType<typeof createClientHarness>) {
  // A failed admission assertion can leave an unexpected physical request pending.
  for (const line of harness.writes) {
    const request = JSON.parse(line) as { id: number; method: string };
    if (request.method === "thread/compact/start") {
      harness.send({ id: request.id, result: {} });
    }
  }
  harness.send(turnEvent("thread-1", "cleanup-turn", "inProgress"));
  harness.send(turnEvent("thread-1", "cleanup-turn", "interrupted"));
}

describe("maybeCompactCodexAppServerSession", () => {
  beforeEach(() => {
    resetCodexTestBindingStore();
    tempDir = tempDirs.make();
  });

  afterEach(() => {
    resetCodexAppServerClientFactoryForTest();
  });

  it.each(["generation", "deadline", "abort"] as const)(
    "settles a compaction retry rejected before write (%s)",
    async (rejection) => {
      const current = {
        kind: "session" as const,
        agentId: "main",
        sessionKey: "agent:main:recovered-retry",
        sessionId: "after-compaction",
      };
      const previous = { ...current, sessionId: "before-compaction" };
      const next = { ...current, sessionId: "next-compaction" };
      const scope = {
        agentId: current.agentId,
        sessionKey: current.sessionKey,
        storePath: path.join(tempDir, "admitted", "sessions.json"),
      };
      await upsertSessionEntry({
        ...scope,
        entry: { sessionId: previous.sessionId, updatedAt: 1 },
      });
      await patchSessionEntry({ ...scope, update: () => ({ sessionId: current.sessionId }) });
      const bindingStore = createCodexTestBindingStore();
      const binding = {
        threadId: "thread-1",
        cwd: tempDir,
        ...(rejection === "abort" ? { contextEngine: contextEngineBinding() } : {}),
      };
      await bindingStore.mutate(previous, { kind: "set", binding });
      const abortController = new AbortController();
      const compactWritten = createDeferred<number>();
      const harness = await createRetainedHarness((request) => {
        if (request.method === "thread/compact/start") {
          compactWritten.resolve(request.id);
        }
      });
      const closeAndWait = vi
        .spyOn(harness.client, "closeAndWait")
        .mockResolvedValue({ exited: false, cleanup: "uncertain" });
      const retirementOutcome = createDeferred<"retained" | "settled">();
      const errorSpy = vi.spyOn(embeddedAgentLog, "error").mockImplementation((message) => {
        if (message === "failed to retire unconfirmed codex app-server compaction") {
          retirementOutcome.resolve("retained");
        }
      });
      vi.useFakeTimers();
      const pending = maybeCompactCodexAppServerSessionImpl(
        {
          sessionId: current.sessionId,
          sessionKey: current.sessionKey,
          agentId: current.agentId,
          sessionTarget: { ...scope, sessionId: current.sessionId },
          sessionFile: path.join(tempDir, "recovered.jsonl"),
          workspaceDir: tempDir,
          trigger: "manual",
          abortSignal: abortController.signal,
        },
        {
          bindingStore,
          clientFactory: async () => harness.client,
          allowNonManualNativeRequest: true,
          pluginConfig: {
            appServer: {
              transport: "websocket",
              url: "ws://127.0.0.1:45001",
              requestTimeoutMs: rejection === "deadline" ? 25 : 5_000,
            },
          },
        },
      ).finally(() => retirementOutcome.resolve("settled"));
      const nextMutation = vi.fn(async () => {});
      let queued: Promise<void> | undefined;
      try {
        const requestId = await compactWritten.promise;
        if (rejection !== "abort") {
          expect(bindingStore.read(current)).toEqual(binding);
        }
        harness.send({
          id: requestId,
          error: { code: -32_001, message: "Server overloaded; retry later." },
        });
        if (rejection === "generation") {
          await patchSessionEntry({ ...scope, update: () => ({ sessionId: next.sessionId }) });
        } else if (rejection === "abort") {
          await vi.advanceTimersByTimeAsync(0);
          abortController.abort();
        }
        queued = withCodexAppServerThreadMutation(binding.threadId, nextMutation);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(await retirementOutcome.promise).toBe("settled");
        expect(harness.writes.map((line) => JSON.parse(line).method)).toEqual([
          "thread/compact/start",
          ...(rejection === "generation" ? ["thread/unsubscribe"] : []),
        ]);
        await expect(pending).resolves.toMatchObject({
          ok: false,
          compacted: false,
          reason: expect.stringContaining(
            rejection === "generation"
              ? "Codex session generation is no longer current"
              : rejection === "deadline"
                ? "thread/compact/start timed out"
                : "thread/compact/start aborted",
          ),
        });
        expect(closeAndWait).not.toHaveBeenCalled();
        expect(bindingStore.read(current)).toEqual(binding);
        expect(harness.client.getCloseError()).toBeUndefined();
        await queued;
        expect(nextMutation).toHaveBeenCalledOnce();
        const recovered = await resolveCodexSessionBinding({
          bindingStore,
          identity: rejection === "generation" ? next : current,
          storePath: scope.storePath,
        });
        expect(recovered.binding).toEqual(binding);
        if (rejection === "generation") {
          await expect(
            consumeCodexAppServerLiveThread(harness.client, binding.threadId),
          ).resolves.toBeUndefined();
        } else if (rejection === "abort") {
          await expect(
            consumeCodexAppServerLiveThread(harness.client, binding.threadId),
          ).resolves.toEqual(expect.objectContaining({ release: expect.any(Function) }));
        }
      } finally {
        settleCompactionHarnessAfterAssertions(harness);
        await pending;
        await queued;
        closeAndWait.mockRestore();
        errorSpy.mockRestore();
        vi.useRealTimers();
        harness.client.close();
      }
    },
  );

  it("never detaches an unconfirmed remote supervised thread", async () => {
    const fake = createFakeCodexCompactionClient(tempDir, {
      autoCompleteCompaction: false,
      rejectInterrupt: true,
    });
    fake.closeAndWait.mockResolvedValueOnce({ exited: false, cleanup: "uncertain" });
    const pluginConfig = {
      supervision: { enabled: true },
      appServer: { transport: "websocket" as const, url: "ws://127.0.0.1:45001" },
    };
    const sessionFile = await writeSupervisedTestBinding(tempDir, {
      threadId: "thread-stuck-supervision",
      appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
        resolveCodexSupervisionAppServerRuntimeOptions({ pluginConfig }),
      ),
    });

    const retirementOutcome = createDeferred<"retained">();
    using _ = vi.spyOn(embeddedAgentLog, "error").mockImplementation((message) => {
      if (message === "failed to retire unconfirmed codex app-server compaction") {
        retirementOutcome.resolve("retained");
      }
    });
    const pendingResult = maybeCompactCodexAppServerSession(compactionParams(sessionFile), {
      clientFactory: async () => fake.client,
      pluginConfig,
      nativeCompletionTimeoutMs: 10,
      nativeInterruptGraceMs: 10,
    });

    try {
      const outcome = await Promise.race([
        pendingResult.then(() => "settled" as const),
        retirementOutcome.promise,
      ]);
      expect(outcome).toBe("retained");
      expect(fake.closeAndWait).toHaveBeenCalledOnce();
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
        threadId: "thread-stuck-supervision",
        connectionScope: "supervision",
      });
    } finally {
      fake.emit(turnEvent("thread-stuck-supervision", "supervised-terminal", "inProgress"));
      fake.emit(turnEvent("thread-stuck-supervision", "supervised-terminal", "interrupted"));
      await pendingResult.finally(() => fake.client.close());
    }
    await expect(pendingResult).resolves.toMatchObject({ ok: false, compacted: false });
  });

  it("cancels compaction while reading a retained supervision thread", async () => {
    const sessionFile = await writeSupervisedTestBinding(tempDir, {
      contextEngine: contextEngineBinding(),
    });
    const binding = await readCodexAppServerBinding(sessionFile);
    const readWritten = createDeferred<number>();
    const compactWritten = createDeferred<void>();
    const harness = await createRetainedHarness((request) => {
      if (request.method === "thread/read") {
        readWritten.resolve(request.id);
      } else if (request.method === "thread/compact/start") {
        compactWritten.resolve();
      }
    });
    const closeAndWait = vi.spyOn(harness.client, "closeAndWait");
    const abortController = new AbortController();
    vi.useFakeTimers();
    const pending = maybeCompactCodexAppServerSession(
      compactionParams(sessionFile, abortController.signal),
      {
        clientFactory: async () => harness.client,
        pluginConfig: { supervision: { enabled: true } },
      },
    );
    const nextMutation = vi.fn(async () => {});
    let queued: Promise<void> | undefined;
    try {
      const readId = await readWritten.promise;
      queued = withCodexAppServerThreadMutation("thread-1", nextMutation);
      abortController.abort();
      harness.send({
        id: readId,
        result: { thread: threadStartResult("thread-1", tempDir).thread },
      });

      expect(
        await Promise.race([
          compactWritten.promise.then(() => "written"),
          pending.then(() => "settled"),
        ]),
      ).toBe("settled");
      expect(
        harness.writes.some((line) => JSON.parse(line).method === "thread/compact/start"),
      ).toBe(false);
      await expect(pending).resolves.toMatchObject({ ok: false, compacted: false });
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(binding);
      expect(closeAndWait).not.toHaveBeenCalled();
      expect(harness.client.getCloseError()).toBeUndefined();
      await queued;
      expect(nextMutation).toHaveBeenCalledOnce();
      await expect(consumeCodexAppServerLiveThread(harness.client, "thread-1")).resolves.toEqual(
        expect.objectContaining({ release: expect.any(Function) }),
      );
    } finally {
      settleCompactionHarnessAfterAssertions(harness);
      await pending;
      await queued;
      closeAndWait.mockRestore();
      vi.useRealTimers();
      harness.client.close();
    }
  });

  it("preserves native completion when cancellation wins the start acknowledgement", async () => {
    const compactWritten = createDeferred<number>();
    const harness = await createRetainedHarness((request) => {
      if (request.method === "thread/compact/start") {
        compactWritten.resolve(request.id);
      }
    });
    const sessionFile = await writeCompactionTestBinding(tempDir);
    const abortController = new AbortController();
    const closeAndWait = vi.spyOn(harness.client, "closeAndWait");
    const pending = maybeCompactCodexAppServerSession(
      compactionParams(sessionFile, abortController.signal),
      { clientFactory: async () => harness.client },
    );
    try {
      const requestId = await compactWritten.promise;
      harness.send(turnEvent("thread-1", "completed-turn", "inProgress"));
      const unrelatedCapture = codexNativeSubagentMonitorRuntime.captureModelSource({
        client: harness.client,
        threadId: "thread-1",
        turnId: "unrelated-turn",
        signal: abortController.signal,
      });
      for (const method of ["item/started", "item/completed"]) {
        harness.send({
          method,
          params: {
            threadId: "thread-1",
            turnId: "completed-turn",
            item: { id: "completed-item", type: "contextCompaction" },
          },
        });
        if (method === "item/started") {
          const capture = await codexNativeSubagentMonitorRuntime.captureModelSource({
            client: harness.client,
            threadId: "thread-1",
            turnId: "completed-turn",
            signal: abortController.signal,
          });
          try {
            expect(capture).toBeDefined();
            capture?.assertCurrent();
            await expect(unrelatedCapture).resolves.toBeUndefined();
          } finally {
            capture?.release();
          }
        }
      }
      harness.send(turnEvent("thread-1", "completed-turn", "completed"));
      abortController.abort();
      harness.send({ id: requestId, result: {} });

      await expect(pending).resolves.toMatchObject({ ok: true, compacted: true });
      await expect(
        codexNativeSubagentMonitorRuntime.captureModelSource({
          client: harness.client,
          threadId: "thread-1",
          turnId: "completed-turn",
        }),
      ).resolves.toBeUndefined();
      expect(closeAndWait).not.toHaveBeenCalled();
      expect(harness.client.getCloseError()).toBeUndefined();
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
        threadId: "thread-1",
      });
      await expect(consumeCodexAppServerLiveThread(harness.client, "thread-1")).resolves.toEqual(
        expect.objectContaining({ release: expect.any(Function) }),
      );
    } finally {
      settleCompactionHarnessAfterAssertions(harness);
      await pending;
      closeAndWait.mockRestore();
      harness.client.close();
    }
  });
});
