import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
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
  compactionItemEvent,
  compactionParams as createCompactionParams,
  createFakeCodexCompactionClient,
  maybeCompactCodexAppServerSession,
  resetCodexAppServerClientFactoryForTest,
  recoveredCompactionBinding,
  writeCompactionTestBinding,
  writeSupervisedTestBinding,
} from "./compact.test-support.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import type { CodexServerNotification } from "./protocol.js";
import { resolveCodexSessionBinding } from "./session-binding.js";
import {
  createCodexTestContextEngineBinding as contextEngineBinding,
  readCodexAppServerBinding,
  resetCodexTestBindingStore,
} from "./session-binding.test-helpers.js";
import { createClientHarness } from "./test-support.js";
import { withCodexAppServerThreadMutation } from "./thread-ownership.js";

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-codex-compact-");
let tempDir: string;
const harnesses: ReturnType<typeof createClientHarness>[] = [];
const pendingWork: Promise<unknown>[] = [];

function track<T>(pending: Promise<T>): Promise<T> {
  pendingWork.push(pending);
  return pending;
}

function observeRetirement() {
  const outcome = createDeferred<"retained" | "settled">();
  vi.spyOn(embeddedAgentLog, "error").mockImplementation((message) => {
    if (message === "failed to retire unconfirmed codex app-server compaction") {
      outcome.resolve("retained");
    }
  });
  return outcome;
}

async function createRetainedHarness(method = "thread/compact/start") {
  const written = createDeferred<number>();
  const compactWritten = createDeferred<void>();
  const harness = createClientHarness({
    onWrite(line, send) {
      const request = JSON.parse(line) as { id: number; method: string };
      if (request.method === "thread/unsubscribe") {
        send({ id: request.id, result: { status: "unsubscribed" } });
      } else if (request.method === "turn/interrupt") {
        send({ id: request.id, result: {} });
      } else {
        if (request.method === method) {
          written.resolve(request.id);
        }
        if (request.method === "thread/compact/start") {
          compactWritten.resolve();
        }
      }
    },
  });
  ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempDir });
  await retainCodexAppServerLiveThread(harness.client, "thread-1");
  harnesses.push(harness);
  return { ...harness, written, compactWritten };
}

function compactionParams(sessionFile: string, abortSignal?: AbortSignal) {
  return createCompactionParams(tempDir, sessionFile, { abortSignal });
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
    setRuntimeConfigSnapshot({});
  });

  afterEach(async () => {
    try {
      harnesses.forEach(settleCompactionHarnessAfterAssertions);
      await Promise.all(pendingWork.splice(0));
    } finally {
      harnesses.splice(0).forEach(({ client }) => client.close());
      vi.restoreAllMocks();
      vi.useRealTimers();
      resetCodexAppServerClientFactoryForTest();
      clearRuntimeConfigSnapshot();
    }
  });

  it.each(["generation", "deadline", "abort"] as const)(
    "settles a compaction retry rejected before write (%s)",
    async (rejection) => {
      const { current, scope, bindingStore, binding } = await recoveredCompactionBinding(
        tempDir,
        "agent:main:recovered-retry",
        rejection === "abort" ? { contextEngine: contextEngineBinding() } : {},
      );
      const next = { ...current, sessionId: "next-compaction" };
      const abortController = new AbortController();
      const harness = await createRetainedHarness();
      const closeAndWait = vi
        .spyOn(harness.client, "closeAndWait")
        .mockResolvedValue({ exited: false, cleanup: "uncertain" });
      const retirementOutcome = observeRetirement();
      vi.useFakeTimers();
      const pending = track(
        maybeCompactCodexAppServerSessionImpl(
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
        ).finally(() => retirementOutcome.resolve("settled")),
      );
      const nextMutation = vi.fn(async () => {});
      const requestId = await harness.written.promise;
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
      const queued = track(withCodexAppServerThreadMutation(binding.threadId, nextMutation));
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await retirementOutcome.promise).toBe("settled");
      expect(harness.writes.map((line) => JSON.parse(line).method)).toEqual([
        "thread/compact/start",
        ...(rejection === "generation" ? ["thread/unsubscribe"] : []),
      ]);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        compacted: false,
        reason:
          rejection === "generation"
            ? expect.stringMatching(
                /Codex session (generation is no longer current|execution policy changed)/,
              )
            : expect.stringContaining(
                rejection === "deadline"
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
      using _ = { [Symbol.dispose]: () => recovered.release() };
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

    const retirementOutcome = observeRetirement();
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
    const harness = await createRetainedHarness("thread/read");
    const closeAndWait = vi.spyOn(harness.client, "closeAndWait");
    const abortController = new AbortController();
    vi.useFakeTimers();
    const pending = track(
      maybeCompactCodexAppServerSession(compactionParams(sessionFile, abortController.signal), {
        clientFactory: async () => harness.client,
        pluginConfig: { supervision: { enabled: true } },
      }),
    );
    const nextMutation = vi.fn(async () => {});
    const readId = await harness.written.promise;
    const queued = track(withCodexAppServerThreadMutation("thread-1", nextMutation));
    abortController.abort();
    harness.send({
      id: readId,
      result: { thread: threadStartResult("thread-1", tempDir).thread },
    });

    expect(
      await Promise.race([
        harness.compactWritten.promise.then(() => "written"),
        pending.then(() => "settled"),
      ]),
    ).toBe("settled");
    expect(harness.writes.some((line) => JSON.parse(line).method === "thread/compact/start")).toBe(
      false,
    );
    await expect(pending).resolves.toMatchObject({ ok: false, compacted: false });
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(binding);
    expect(closeAndWait).not.toHaveBeenCalled();
    expect(harness.client.getCloseError()).toBeUndefined();
    await queued;
    expect(nextMutation).toHaveBeenCalledOnce();
    await expect(consumeCodexAppServerLiveThread(harness.client, "thread-1")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
  });

  it("preserves native completion when cancellation wins the start acknowledgement", async () => {
    const harness = await createRetainedHarness();
    const sessionFile = await writeCompactionTestBinding(tempDir);
    const abortController = new AbortController();
    const captureSource = (turnId: string, signal?: AbortSignal) =>
      codexNativeSubagentMonitorRuntime.captureModelSource({
        client: harness.client,
        threadId: "thread-1",
        turnId,
        signal,
      });
    const closeAndWait = vi.spyOn(harness.client, "closeAndWait");
    const pending = track(
      maybeCompactCodexAppServerSession(compactionParams(sessionFile, abortController.signal), {
        clientFactory: async () => harness.client,
      }),
    );
    const requestId = await harness.written.promise;
    harness.send(turnEvent("thread-1", "completed-turn", "inProgress"));
    const unrelatedCapture = captureSource("unrelated-turn", abortController.signal);
    for (const method of ["item/started", "item/completed"] as const) {
      harness.send(compactionItemEvent(method, "completed-turn", "completed-item"));
      if (method === "item/started") {
        const capture = await captureSource("completed-turn", abortController.signal);
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
    await expect(captureSource("completed-turn")).resolves.toBeUndefined();
    expect(closeAndWait).not.toHaveBeenCalled();
    expect(harness.client.getCloseError()).toBeUndefined();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-1",
    });
    await expect(consumeCodexAppServerLiveThread(harness.client, "thread-1")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
  });
});
