import path from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  claimCodexAppServerLiveThread,
  consumeCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { CodexAppServerClient } from "./client.js";
import { threadStartResult } from "./codex-app-server.test-fixtures.js";
import { compactCodexSessionWithTestHost as maybeCompactCodexAppServerSession } from "./compact.test-support.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import {
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  retainSharedCodexAppServerClientIfCurrent,
  retireSharedCodexAppServerClientIfCurrent,
  resetSharedCodexAppServerClientForTests,
} from "./shared-client.js";
import * as sharedClientRuntime from "./shared-client.js";
import { createInferenceReadyClientHarness, useAutoCleanupTempDirTracker } from "./test-support.js";
import {
  createParams,
  resetThreadLifecycleTestFixtures,
  startOrResumeThread,
} from "./thread-lifecycle.test-fixtures.js";
import {
  releaseCodexAppServerBindingSubscription,
  retainCodexAppServerBindingSubscription,
  withCodexAppServerThreadMutation,
} from "./thread-ownership.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let directory: string;
let agentDir: string;
let sessionFile: string;
const pluginConfig = {
  appServer: { command: process.execPath, args: ["app-server"], homeScope: "user" },
};
let runtime: ReturnType<typeof resolveCodexAppServerRuntimeOptions>;
const transports: ReturnType<typeof createInferenceReadyClientHarness>[] = [];

beforeEach(() => {
  directory = tempDirs.make("codex-compact-owner-");
  agentDir = path.join(directory, "agent");
  sessionFile = path.join(directory, "session.jsonl");
  runtime = resolveCodexAppServerRuntimeOptions({
    pluginConfig,
    codexConfigToml: null,
    requirementsToml: null,
  });
});

afterEach(async () => {
  resetSharedCodexAppServerClientForTests();
  await Promise.all(transports.splice(0).map(({ client }) => client.closeAndWait()));
  resetCodexTestBindingStore();
  resetThreadLifecycleTestFixtures();
  vi.restoreAllMocks();
});

function createOwnershipHarness(
  respond: (
    request: { id: number; method: string; params?: { threadId?: string } },
    send: (message: unknown) => void,
  ) => void,
  autoEmitExit = true,
) {
  return createInferenceReadyClientHarness({
    autoEmitExit,
    onWrite(line, send) {
      const request = JSON.parse(line) as Parameters<typeof respond>[0];
      if (request.id === undefined) {
        return;
      }
      if (request.method === "initialize") {
        send({
          id: request.id,
          result: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}`, codexHome: directory },
        });
      } else {
        respond(request, send);
      }
    },
  });
}

function sendCompactionCompleted(
  send: (message: unknown) => void,
  threadId: string,
  turnId: string,
) {
  const turn = { id: turnId, threadId, status: "completed" };
  send({
    method: "turn/started",
    params: { threadId, turn: { ...turn, status: "inProgress" } },
  });
  for (const method of ["item/started", "item/completed"]) {
    send({
      method,
      params: {
        threadId,
        turnId,
        item: { id: "compacted", type: "contextCompaction" },
      },
    });
  }
  send({ method: "turn/completed", params: { threadId, turn } });
}

it.each(["warm", "closed", "detached", "unconfirmed-close", "rejected-close"])(
  "supports repeated compaction and the next turn (owner %s)",
  async (ownerState) => {
    const closeFails = ownerState === "unconfirmed-close" || ownerState === "rejected-close";
    const ownerClosed = ownerState === "closed" || closeFails;
    const sessionKey = "agent:main:compact-owner";
    const owners = new Map<string, number>();
    const operations: { client: number; method: string; threadId?: string }[] = [];
    vi.spyOn(CodexAppServerClient, "start").mockImplementation(async () => {
      const index = transports.length;
      const harness = createOwnershipHarness((request, send) => {
        const threadId = request.params?.threadId;
        operations.push({ client: index, method: request.method, threadId });
        // Codex's thread_resume cross-process contract retains the writer after turn completion.
        if (
          request.method === "thread/resume" &&
          threadId &&
          owners.has(threadId) &&
          owners.get(threadId) !== index
        ) {
          send({
            id: request.id,
            error: { code: -32600, message: `thread ${threadId} already has an active writer` },
          });
          return;
        }
        if (request.method === "thread/resume" && threadId) {
          owners.set(threadId, index);
          send({
            id: request.id,
            result: threadStartResult(threadId, directory),
          });
          return;
        }
        // Unsubscribe stops notifications, but Codex keeps the writer until idle eviction or exit.
        if (
          (request.method === "turn/start" || request.method === "thread/compact/start") &&
          threadId
        ) {
          const turn = { id: "finished-turn", threadId, status: "completed" };
          if (request.method === "thread/compact/start") {
            sendCompactionCompleted(send, threadId, turn.id);
          } else {
            send({ method: "turn/completed", params: { threadId, turn } });
          }
          send({ id: request.id, result: request.method === "turn/start" ? { turn } : {} });
          return;
        }
        send({ id: request.id, result: {} });
      });
      harness.client.addTransportExitHandler(() => {
        for (const [threadId, ownerIndex] of owners) {
          if (ownerIndex === index) {
            owners.delete(threadId);
          }
        }
      });
      transports.push(harness);
      if (closeFails && index === 1) {
        const close = vi.spyOn(harness.client, "closeAndWait");
        if (ownerState === "rejected-close") {
          close.mockRejectedValueOnce(new Error("catalog worker shutdown failed"));
        } else {
          close.mockResolvedValueOnce({ exited: false, cleanup: "uncertain" });
        }
      }
      return harness.client;
    });
    const owner = await getLeasedSharedCodexAppServerClient({
      startOptions: {
        ...runtime.start,
        env: { ...runtime.start.env, COMPACTION_TEST_SHELL: "prepared" },
      },
      agentDir,
      authProfileId: null,
    });
    await owner.request(
      "thread/resume",
      { threadId: "owned-thread", excludeTurns: true },
      { timeoutMs: 1000 },
    );
    await owner.request("turn/start", { threadId: "owned-thread", input: [] }, { timeoutMs: 1000 });
    await retainCodexAppServerLiveThread(owner, "owned-thread");
    await owner.request(
      "thread/resume",
      { threadId: "sibling-thread", excludeTurns: true },
      { timeoutMs: 1000 },
    );
    await retainCodexAppServerLiveThread(owner, "sibling-thread");
    registerCodexTestSessionIdentity(sessionFile, "session-1", sessionKey, "main");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "owned-thread",
      cwd: directory,
      clientId: owner.getInstanceId(),
    });
    releaseLeasedSharedCodexAppServerClient(owner);
    const releaseSiblingLease =
      ownerState === "detached" ? retainSharedCodexAppServerClientIfCurrent(owner) : undefined;
    if (ownerState === "detached") {
      expect(releaseSiblingLease).toBeDefined();
      expect(retireSharedCodexAppServerClientIfCurrent(owner)?.closed).toBe(false);
    }
    if (ownerClosed) {
      expect(await owner.closeAndWait()).toMatchObject({ exited: true });
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const compaction = maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey,
          sessionFile,
          agentDir,
          workspaceDir: directory,
          trigger: "manual",
        },
        { bindingStore: testCodexAppServerBindingStore, pluginConfig },
      );

      if (closeFails) {
        await expect(compaction).rejects.toThrow(
          ownerState === "rejected-close"
            ? "catalog worker shutdown failed"
            : "Codex compaction client did not exit",
        );
        expect(owners.get("owned-thread")).toBe(1);
        expect(operations.some(({ method }) => method === "thread/compact/start")).toBe(true);
        let queueEntered = false;
        const queued = withCodexAppServerThreadMutation("owned-thread", async () => {
          queueEntered = true;
        });
        try {
          await setImmediate();
          expect(queueEntered).toBe(false);
        } finally {
          transports[1]?.emitExit();
          await queued;
        }
        expect(queueEntered).toBe(true);
        return;
      }
      const result = await compaction;
      expect(result, JSON.stringify({ result, operations })).toMatchObject({
        ok: true,
        compacted: true,
      });
      expect(owners.get("owned-thread")).toBe(ownerClosed ? undefined : 0);
      expect(owners.get("sibling-thread")).toBe(ownerClosed ? undefined : 0);
    }
    expect(operations.filter(({ method }) => method === "thread/compact/start")).toEqual([
      { client: ownerClosed ? 1 : 0, method: "thread/compact/start", threadId: "owned-thread" },
      { client: ownerClosed ? 2 : 0, method: "thread/compact/start", threadId: "owned-thread" },
    ]);
    if (!ownerClosed) {
      expect(await consumeCodexAppServerLiveThread(owner, "owned-thread")).toBeDefined();
      expect(await consumeCodexAppServerLiveThread(owner, "sibling-thread")).toBeDefined();
    }
    const nextOwner =
      ownerState === "detached"
        ? owner
        : await getLeasedSharedCodexAppServerClient({
            startOptions: {
              ...runtime.start,
              env: { ...runtime.start.env, COMPACTION_TEST_SHELL: "prepared" },
            },
            agentDir,
            authProfileId: null,
          });
    try {
      await nextOwner.request(
        "thread/resume",
        { threadId: "owned-thread", excludeTurns: true },
        { timeoutMs: 1000 },
      );
      await expect(
        nextOwner.request(
          "turn/start",
          { threadId: "owned-thread", input: [] },
          { timeoutMs: 1000 },
        ),
      ).resolves.toMatchObject({ turn: { status: "completed" } });
    } finally {
      if (releaseSiblingLease) {
        releaseSiblingLease();
      } else {
        releaseLeasedSharedCodexAppServerClient(nextOwner);
      }
    }
  },
);

it.each([
  ["success", false, "untracked"],
  ["failure", false, "untracked"],
  ["success", true, "untracked"],
  ["failure", true, "untracked"],
  ["success", "during-resume", "untracked"],
  ["failure", "during-resume", "untracked"],
  ["success", "during-resume", "claimed"],
  ["failure", "during-resume", "claimed"],
  ["success", "during-resume", "idle"],
  ["failure", "during-resume", "idle"],
] as const)(
  "fences replacement resume after compaction %s (late final release: %s, subscription: %s)",
  async (outcome, lateRelease, subscription) => {
    const sessionKey = "agent:main:compact-final-owner";
    const threadId = "final-owner-thread";
    const ownerClaimed = subscription === "claimed";
    const ownerWrites = subscription === "untracked" ? [0, 0] : [0, 0, 0];
    let ownerExited = false;
    const resumes: number[] = [];
    const compactStarted = createDeferred<{
      id: number;
      send: (message: unknown) => void;
    }>();
    vi.spyOn(CodexAppServerClient, "start").mockImplementation(async () => {
      const index = transports.length;
      const harness = createOwnershipHarness((request, send) => {
        const result = threadStartResult(request.params?.threadId ?? threadId, directory);
        result.thread.sessionId = "session-final-owner";
        if (request.method === "thread/read") {
          send({
            id: request.id,
            result: { thread: { ...result.thread, status: { type: "notLoaded" } } },
          });
          return;
        }
        if (request.method === "thread/resume" || request.method === "thread/start") {
          resumes.push(index);
          if (index > 0 && !ownerExited) {
            send({
              id: request.id,
              error: { code: -32600, message: "thread already has an active writer" },
            });
            return;
          }
          send({ id: request.id, result });
          return;
        }
        if (request.method === "thread/compact/start") {
          compactStarted.resolve({ id: request.id, send });
          return;
        }
        send({
          id: request.id,
          result: request.method === "configRequirements/read" ? { requirements: null } : {},
        });
      }, index !== 0);
      if (index === 0) {
        harness.client.addTransportExitHandler(() => {
          ownerExited = true;
        });
      }
      transports.push(harness);
      return harness.client;
    });

    const owner = await getLeasedSharedCodexAppServerClient({
      startOptions: runtime.start,
      agentDir,
      authProfileId: null,
    });
    registerCodexTestSessionIdentity(sessionFile, "session-final-owner", sessionKey, "main");
    const prepareThread = (client: CodexAppServerClient) =>
      startOrResumeThread({
        client,
        params: {
          ...createParams(sessionFile, directory),
          sessionId: "session-final-owner",
          sessionKey,
          agentDir,
          agentId: "main",
        },
        cwd: directory,
        dynamicTools: [],
        appServer: runtime,
        userMcpServersEnabled: false,
      });
    await prepareThread(owner);
    const releaseRetirementLease = retainSharedCodexAppServerClientIfCurrent(owner);
    expect(releaseRetirementLease).toBeDefined();
    expect(releaseLeasedSharedCodexAppServerClient(owner)).toBe(true);
    expect(retireSharedCodexAppServerClientIfCurrent(owner)).toEqual({
      activeLeases: 1,
      closed: false,
    });

    const compaction = maybeCompactCodexAppServerSession(
      {
        sessionId: "session-final-owner",
        sessionKey,
        sessionFile,
        agentDir,
        workspaceDir: directory,
        trigger: "manual",
      },
      { bindingStore: testCodexAppServerBindingStore, pluginConfig },
    );
    const pendingCompact = await compactStarted.promise;
    if (!lateRelease) {
      releaseRetirementLease?.();
    }
    if (outcome === "success") {
      sendCompactionCompleted(pendingCompact.send, threadId, "compaction-turn");
      pendingCompact.send({ id: pendingCompact.id, result: {} });
    } else {
      pendingCompact.send({
        id: pendingCompact.id,
        error: { code: -32603, message: "forced compaction failure" },
      });
    }

    const compactionResult = await compaction;
    expect(compactionResult).toMatchObject(
      outcome === "success"
        ? { ok: true, compacted: true }
        : { ok: false, compacted: false, reason: "forced compaction failure" },
    );
    if (lateRelease === true) {
      releaseRetirementLease?.();
    }
    const harness = transports[0];
    expect(harness?.stdinDestroyed).toBe(lateRelease !== "during-resume");

    if (subscription !== "untracked") {
      await owner.request("thread/resume", { threadId }, { timeoutMs: 1_000 });
      if (ownerClaimed) {
        expect(await claimCodexAppServerLiveThread(owner, threadId)).toBeDefined();
      } else {
        expect(await retainCodexAppServerBindingSubscription(owner, threadId)).toBe(true);
      }
    }
    const nextOwner = await getLeasedSharedCodexAppServerClient({
      startOptions: runtime.start,
      agentDir,
      authProfileId: null,
    });
    const entered = createDeferred<void>();
    const released = createDeferred<void>();
    let acquired = false;
    const retain = sharedClientRuntime.retainSharedCodexAppServerClientByInstanceId;
    vi.spyOn(
      sharedClientRuntime,
      "retainSharedCodexAppServerClientByInstanceId",
    ).mockImplementation((id) => {
      const result = retain(id);
      void Promise.resolve(result).then((lease) => {
        acquired = true;
        if (lease) {
          const release = lease.release;
          vi.spyOn(lease, "release").mockImplementation((wait) => {
            const exit = release(wait);
            released.resolve();
            return exit;
          });
        }
      });
      entered.resolve();
      return result;
    });
    let queueEntered = false;
    const queued = withCodexAppServerThreadMutation(threadId, async () => {
      queueEntered = true;
    });
    const successor = prepareThread(nextOwner).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      if (lateRelease) {
        await Promise.race([
          entered.promise,
          successor.then((result) => {
            throw "error" in result
              ? result.error
              : new Error("resume skipped recorded-owner acquisition");
          }),
        ]);
        await Promise.resolve();
        expect(acquired).toBe(lateRelease === "during-resume");
        if (lateRelease === "during-resume") {
          await released.promise;
          await setImmediate();
          if (ownerClaimed) {
            expect(
              await Promise.race([successor, Promise.resolve({ pending: true })]),
            ).toMatchObject({
              error: expect.objectContaining({ message: expect.stringContaining("claimed") }),
            });
            const rejectedRelease = releaseCodexAppServerBindingSubscription({
              threadId,
              clientId: owner.getInstanceId(),
            }).catch((error: unknown) => error);
            await setImmediate();
            expect(await Promise.race([rejectedRelease, Promise.resolve(null)])).toMatchObject({
              message: expect.stringContaining("active run"),
            });
          }
          releaseRetirementLease?.();
          expect(harness?.stdinDestroyed).toBe(true);
        }
      } else {
        await delay(20);
        expect(queueEntered).toBe(false);
        expect(
          sharedClientRuntime.retainSharedCodexAppServerClientByInstanceId,
        ).not.toHaveBeenCalled();
      }
      expect(resumes).toEqual(ownerWrites);
    } finally {
      releaseRetirementLease?.();
      harness?.emitExit();
      await queued;
      await successor;
    }
    expect(queueEntered).toBe(true);
    expect(await successor).toMatchObject(
      ownerClaimed
        ? { error: expect.any(Error) }
        : { value: { threadId, lifecycle: { action: "resumed" } } },
    );
    expect(resumes).toEqual(ownerClaimed ? ownerWrites : [...ownerWrites, 1]);
    releaseLeasedSharedCodexAppServerClient(nextOwner);
  },
);

it("cancels compaction waiting for a closing owner without releasing its thread queue", async () => {
  const harness = createOwnershipHarness(() => {}, false);
  transports.push(harness);
  const start = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
  const owner = await getLeasedSharedCodexAppServerClient({
    startOptions: runtime.start,
    agentDir,
    authProfileId: null,
  });
  const sessionKey = "agent:main:closing-owner";
  registerCodexTestSessionIdentity(sessionFile, "closing-session", sessionKey, "main");
  await writeCodexAppServerBinding(sessionFile, {
    threadId: "closing-thread",
    cwd: directory,
    clientId: owner.getInstanceId(),
  });
  releaseLeasedSharedCodexAppServerClient(owner);
  owner.close();
  const entered = createDeferred<void>();
  const retain = sharedClientRuntime.retainSharedCodexAppServerClientByInstanceId;
  vi.spyOn(sharedClientRuntime, "retainSharedCodexAppServerClientByInstanceId").mockImplementation(
    (id) => {
      const work = retain(id);
      entered.resolve();
      return work;
    },
  );
  const abort = new AbortController();
  const compaction = maybeCompactCodexAppServerSession(
    {
      sessionId: "closing-session",
      sessionKey,
      sessionFile,
      agentDir,
      workspaceDir: directory,
      trigger: "manual",
      abortSignal: abort.signal,
    },
    { bindingStore: testCodexAppServerBindingStore, pluginConfig },
  );
  let queueEntered = false;
  let queued: Promise<void> | undefined;
  try {
    await entered.promise;
    abort.abort();
    expect(
      await Promise.race([compaction, setImmediate().then(() => "still pending")]),
    ).toMatchObject({
      ok: false,
      compacted: false,
      reason: "codex app-server compaction aborted while waiting to start",
    });
    queued = withCodexAppServerThreadMutation("closing-thread", async () => {
      queueEntered = true;
    });
    await setImmediate();
    expect(queueEntered).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
  } finally {
    harness.emitExit();
    await Promise.allSettled([compaction, queued]);
  }
  expect(queueEntered).toBe(true);
  expect(start).toHaveBeenCalledTimes(1);
});
