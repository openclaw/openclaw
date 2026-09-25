import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import {
  beginCompactionTestCleanup,
  createFakeCodexCompactionClient,
  maybeCompactCodexAppServerSession,
  resetCodexAppServerClientFactoryForTest,
  setCodexAppServerClientFactoryForTest,
  writeCompactionTestBinding,
} from "./compact.test-support.js";
import {
  readCodexAppServerBinding,
  resetCodexTestBindingStore,
  seedCodexTestBinding,
} from "./session-binding.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const INCOGNITO_COMPACT_KEY = "agent:main:dashboard:incognito-compact-catalog";
let tempDir: string;
let finishCompactionTestCleanup: ReturnType<typeof beginCompactionTestCleanup>;

function writeTestBinding(
  options: Parameters<typeof writeCompactionTestBinding>[1] = {},
  sessionKey = "agent:main:session-1",
) {
  return writeCompactionTestBinding(tempDir, options, sessionKey);
}

function createFakeCodexClient(options?: Parameters<typeof createFakeCodexCompactionClient>[1]) {
  return createFakeCodexCompactionClient(tempDir, options);
}

function startCompaction(sessionFile: string) {
  return maybeCompactCodexAppServerSession({
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir: tempDir,
    trigger: "manual",
  });
}

describe("native compaction subscription ownership", () => {
  beforeEach(() => {
    resetCodexTestBindingStore();
    tempDir = tempDirs.make("openclaw-codex-compact-ownership-");
    finishCompactionTestCleanup = beginCompactionTestCleanup();
  });

  afterEach(async ({ task }) => {
    try {
      await finishCompactionTestCleanup(task.result?.state === "fail");
    } finally {
      resetCodexAppServerClientFactoryForTest();
    }
  });

  it("compacts a warm session without displacing its independently retained sibling", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    await fake.client.request("thread/resume", { threadId: "thread-2", excludeTurns: true });
    await retainCodexAppServerLiveThread(
      fake.client,
      "thread-2",
      async (threadId) => {
        await fake.client.request("thread/unsubscribe", { threadId });
      },
      "config-thread-2",
    );
    fake.request.mockClear();

    await expect(startCompaction(sessionFile)).resolves.toMatchObject({
      ok: true,
      compacted: true,
    });

    expect(fake.request.mock.calls.map(([method]) => method)).toEqual(["thread/compact/start"]);
    await expect(
      consumeCodexAppServerLiveThread(fake.client, "thread-1", "config-thread-1"),
    ).resolves.toEqual(expect.objectContaining({ configFingerprint: "config-thread-1" }));
    await expect(
      consumeCodexAppServerLiveThread(fake.client, "thread-2", "config-thread-2"),
    ).resolves.toEqual(expect.objectContaining({ configFingerprint: "config-thread-2" }));
  });

  it("keeps an owned thread subscribed when a sibling finishes during compaction", async () => {
    const fake = createFakeCodexClient({ autoCompleteCompaction: false });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();
    const pending = startCompaction(sessionFile);
    try {
      await vi.waitFor(() => {
        expect(fake.request).toHaveBeenCalledWith(
          "thread/compact/start",
          { threadId: "thread-1" },
          {
            assertCurrent: expect.any(Function),
            withCurrent: expect.any(Function),
            signal: expect.any(AbortSignal),
          },
        );
      });

      await fake.client.request("thread/resume", { threadId: "thread-2", excludeTurns: true });
      await retainCodexAppServerLiveThread(fake.client, "thread-2", undefined, "config-thread-2");
      fake.completeCompaction();

      await expect(pending).resolves.toMatchObject({ ok: true, compacted: true });
      expect(fake.request).not.toHaveBeenCalledWith(
        "thread/unsubscribe",
        { threadId: "thread-1" },
        expect.anything(),
      );
      await expect(
        consumeCodexAppServerLiveThread(fake.client, "thread-1", "config-thread-1"),
      ).resolves.toEqual(expect.objectContaining({ configFingerprint: "config-thread-1" }));
      await expect(
        consumeCodexAppServerLiveThread(fake.client, "thread-2", "config-thread-2"),
      ).resolves.toEqual(expect.objectContaining({ configFingerprint: "config-thread-2" }));
    } finally {
      // Failed assertions must not strand the shared native-thread mutation queue.
      fake.completeCompaction();
      await pending;
    }
  });

  it("releases an obsolete physical owner when compaction migrates the same native thread", async () => {
    const fake = createFakeCodexClient({ autoCompleteCompaction: false });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({ clientId: "client-before-compaction" });
    const pending = startCompaction(sessionFile);
    try {
      await vi.waitFor(() => {
        expect(fake.request).toHaveBeenCalledWith(
          "thread/compact/start",
          { threadId: "thread-1" },
          {
            assertCurrent: expect.any(Function),
            withCurrent: expect.any(Function),
            signal: expect.any(AbortSignal),
          },
        );
      });

      seedCodexTestBinding(sessionFile, {
        threadId: "thread-1",
        clientId: "client-after-compaction",
        cwd: tempDir,
      });
      fake.completeCompaction();

      await expect(pending).resolves.toMatchObject({ ok: true, compacted: true });
      expect(fake.request.mock.calls.filter(([method]) => method === "thread/unsubscribe")).toEqual(
        [
          [
            "thread/unsubscribe",
            { threadId: "thread-1" },
            expect.objectContaining({ timeoutMs: expect.any(Number) }),
          ],
        ],
      );
      await expect(
        consumeCodexAppServerLiveThread(fake.client, "thread-1"),
      ).resolves.toBeUndefined();
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
        threadId: "thread-1",
        clientId: "client-after-compaction",
      });
    } finally {
      // Failed assertions must not strand the shared native-thread mutation queue.
      fake.completeCompaction();
      await pending;
    }
  });

  it("preserves an incognito thread's separately owned live subscription", async () => {
    const fake = createFakeCodexClient({
      retainedThreadId: null,
      subscribedThreadIds: ["thread-1"],
    });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionKey = "agent:main:dashboard:incognito-compact";
    const sessionFile = await writeTestBinding({}, sessionKey);

    await expect(
      maybeCompactCodexAppServerSession({
        sessionId: "session-1",
        sessionKey,
        sessionFile,
        workspaceDir: tempDir,
        trigger: "manual",
      }),
    ).resolves.toMatchObject({ ok: true, compacted: true });

    expect(fake.request.mock.calls.map(([method]) => method)).toEqual(["thread/compact/start"]);
  });

  it.each([
    // The incognito key is the path that actually matters: it keeps its own live
    // subscription, so compaction never claims and re-retains the thread.
    { label: "an edited catalog", refreshed: "catalog B", sessionKey: INCOGNITO_COMPACT_KEY },
    { label: "a withdrawn catalog", refreshed: undefined, sessionKey: INCOGNITO_COMPACT_KEY },
    { label: "an edited catalog", refreshed: "catalog B", sessionKey: "agent:main:session-1" },
    { label: "a withdrawn catalog", refreshed: undefined, sessionKey: "agent:main:session-1" },
  ])(
    "records $label as reverted after standalone compaction on $sessionKey",
    async ({ refreshed, sessionKey }) => {
      const fake = createFakeCodexClient();
      setCodexAppServerClientFactoryForTest(async () => fake.client);
      const sessionFile = await writeTestBinding({}, sessionKey);
      // The live thread was created with catalog A and refreshed in place, so
      // only the injected message carries the current catalog.
      const ephemeralPolicy = {
        developerInstructions: "generic policy",
        skillsInstructions: refreshed,
        nativeSkillsInstructions: "catalog A",
      };
      await retainCodexAppServerLiveThread(
        fake.client,
        "thread-1",
        undefined,
        "config-thread-1",
        null,
        ephemeralPolicy,
      );

      await expect(
        maybeCompactCodexAppServerSession({
          sessionId: "session-1",
          sessionKey,
          sessionFile,
          workspaceDir: tempDir,
          trigger: "manual",
        }),
      ).resolves.toMatchObject({ ok: true, compacted: true });

      // Compaction discarded the injected refresh. Preserving the creation policy
      // keeps the live thread from reading as policy drift, and the reverted
      // catalog is what makes the next turn deliver the current one again.
      await expect(
        consumeCodexAppServerLiveThread(fake.client, "thread-1", "config-thread-1"),
      ).resolves.toEqual(
        expect.objectContaining({
          ephemeralPolicy: {
            developerInstructions: "generic policy",
            skillsInstructions: "catalog A",
            nativeSkillsInstructions: "catalog A",
          },
        }),
      );
    },
  );
});
