import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendSessionTranscriptMessage } from "../../../config/sessions/transcript-append.js";
import {
  runWithOwnedSessionTranscriptWriteLock,
  runWithOwnedSessionTranscriptWritePublication,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import { SessionWriteLockTimeoutError } from "../../session-write-lock-error.js";
import {
  createEmbeddedAttemptSessionLockController,
  EmbeddedAttemptSessionTakeoverError,
  installPromptSubmissionLockRelease,
  installSessionEventWriteLock,
  installSessionExternalHookWriteLock,
  readSessionFileFingerprintSync,
} from "./attempt.session-lock.js";

const lockOptions = {
  sessionFile: "/tmp/session.jsonl",
  timeoutMs: 60_000,
  staleMs: 1_800_000,
  maxHoldMs: 300_000,
};

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function createTempSessionFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attempt-session-lock-"));
  tempDirs.push(dir);
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(sessionFile, '{"type":"session"}\n', "utf8");
  return sessionFile;
}

describe("embedded attempt session lock lifecycle", () => {
  it("releases the coarse attempt lock before prompt submission and reacquires for cleanup", async () => {
    const releases: string[] = [];
    const acquireSessionWriteLock = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => releases.push("prep")) })
      .mockResolvedValueOnce({ release: vi.fn(async () => releases.push("cleanup")) });

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions,
    });

    await controller.releaseForPrompt();
    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(2);
    expect(acquireSessionWriteLock).toHaveBeenNthCalledWith(1, lockOptions);
    expect(acquireSessionWriteLock).toHaveBeenNthCalledWith(2, lockOptions);
    expect(releases).toEqual(["prep", "cleanup"]);
  });

  it("releases the eagerly-held attempt lock on dispose when cleanup is skipped (#86014)", async () => {
    const releases: string[] = [];
    const acquireSessionWriteLock = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => releases.push("held")) });

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions,
    });

    // An exception on the post-prompt path skips acquireForCleanup; the run's outer finally
    // must still release the eagerly-held lock or it leaks to the live process.
    await controller.dispose();
    await controller.dispose(); // idempotent

    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(1);
    expect(releases).toEqual(["held"]);
  });

  it("dispose does not double-release a lock already handed to cleanup", async () => {
    const releases: string[] = [];
    const acquireSessionWriteLock = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => releases.push("held")) });

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions,
    });

    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();
    await controller.dispose();

    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(1);
    expect(releases).toEqual(["held"]);
  });

  it("defensively releases the coarse attempt lock on sessions_yield abort cleanup", async () => {
    const events: string[] = [];
    const acquireSessionWriteLock = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => events.push("prep-release")) })
      .mockResolvedValueOnce({ release: vi.fn(async () => events.push("cleanup-release")) });

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions,
    });

    await controller.releaseHeldLockForAbort();
    await controller.withSessionWriteLock(async () => {
      events.push("yield-cleanup-write");
    });

    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["prep-release", "yield-cleanup-write", "cleanup-release"]);
  });

  it("keeps the session fence active after releasing for sessions_yield abort cleanup", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseHeldLockForAbort();
    await fs.appendFile(sessionFile, '{"type":"message","id":"abort-takeover"}\n', "utf8");

    await expect(controller.withSessionWriteLock(() => "yield-cleanup")).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("runs post-prompt transcript writes under a short reacquired lock", async () => {
    const events: string[] = [];
    const acquireSessionWriteLock = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => events.push("prep-release")) })
      .mockResolvedValueOnce({ release: vi.fn(async () => events.push("post-release")) });

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions,
    });

    await controller.releaseForPrompt();
    await controller.withSessionWriteLock(async () => {
      events.push("post-write");
    });

    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["prep-release", "post-write", "post-release"]);
  });

  it("keeps settled compaction hooks on the normal acquire-and-release path", async () => {
    const events: string[] = [];
    const acquireSessionWriteLock = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => events.push("prep-release")) })
      .mockResolvedValueOnce({ release: vi.fn(async () => events.push("compact-release")) });
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions,
    });
    const session = {
      compact: vi.fn(async () => {
        events.push("compact");
      }),
    };

    installSessionExternalHookWriteLock({
      session,
      withSessionWriteLock: controller.withSessionWriteLock,
    });

    await controller.releaseForPrompt();
    await session.compact();

    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["prep-release", "compact", "compact-release"]);
  });

  it("reuses its active post-prompt lock for nested session writes", async () => {
    const events: string[] = [];
    const sessionFile = await createTempSessionFile();
    const acquireSessionWriteLock = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => events.push("prep-release")) })
      .mockResolvedValueOnce({ release: vi.fn(async () => events.push("post-release")) })
      .mockRejectedValueOnce(
        new SessionWriteLockTimeoutError({
          timeoutMs: lockOptions.timeoutMs,
          owner: "pid=789",
          lockPath: `${sessionFile}.lock`,
        }),
      );

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await controller.withSessionWriteLock(async () => {
      events.push("outer-start");
      await fs.appendFile(sessionFile, '{"type":"message","id":"local"}\n', "utf8");
      await controller.withSessionWriteLock(async () => {
        events.push("inner-write");
      });
      events.push("outer-end");
    });

    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      "prep-release",
      "outer-start",
      "inner-write",
      "outer-end",
      "post-release",
    ]);
  });

  it("drains queued Pi session events before reacquiring for cleanup", async () => {
    const events: string[] = [];
    let resolveQueue!: () => void;
    const session = {
      _agentEventQueue: new Promise<void>((resolve) => {
        resolveQueue = resolve;
      }).then(() => {
        events.push("events-drained");
      }),
    };
    let acquireCount = 0;
    const acquireSessionWriteLock = vi.fn(async () => {
      acquireCount += 1;
      events.push(`acquire-${acquireCount}`);
      return {
        release: vi.fn(async () => {
          events.push("release");
        }),
      };
    });

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions,
    });
    await controller.releaseForPrompt();
    const cleanupLockPromise = controller.acquireForCleanup({ session });

    await Promise.resolve();
    expect(events).toEqual(["acquire-1", "release"]);

    resolveQueue();
    const cleanupLock = await cleanupLockPromise;
    await cleanupLock.release();

    expect(events).toEqual(["acquire-1", "release", "events-drained", "acquire-2", "release"]);
  });

  it("rejects post-prompt writes when another owner advances the session file", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await fs.appendFile(sessionFile, '{"type":"message","id":"takeover"}\n', "utf8");

    await expect(controller.withSessionWriteLock(() => "late-write")).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);

    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    expect(release).toHaveBeenCalledTimes(2);
  });

  it("refreshes the prompt fence after an owned write throws", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await expect(
      controller.withSessionWriteLock(async () => {
        await fs.appendFile(sessionFile, '{"type":"message","id":"owned-before-error"}\n', "utf8");
        throw new Error("downstream event handler failed");
      }),
    ).rejects.toThrow("downstream event handler failed");
    await expect(controller.withSessionWriteLock(() => "finalize")).resolves.toBe("finalize");

    expect(controller.hasSessionTakeover()).toBe(false);
    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(3);
  });

  it("does not reuse a released lock from inherited async context", async () => {
    const sessionFile = await createTempSessionFile();
    let resumeDetached!: () => void;
    const detachedGate = new Promise<void>((resolve) => {
      resumeDetached = resolve;
    });
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    let detachedWrite!: Promise<void>;
    await controller.withSessionWriteLock(async () => {
      detachedWrite = (async () => {
        await detachedGate;
        await controller.withSessionWriteLock(async () => {
          await fs.appendFile(sessionFile, '{"type":"message","id":"detached-owned"}\n', "utf8");
        });
      })();
    });

    resumeDetached();
    await detachedWrite;
    await expect(controller.withSessionWriteLock(() => "finalize")).resolves.toBe("finalize");

    expect(controller.hasSessionTakeover()).toBe(false);
    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(4);
    expect(release).toHaveBeenCalledTimes(4);
  });

  it("keeps post-provider transcript writes owned after prompt stream returns", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await controller.reacquireAfterPrompt();
    await fs.appendFile(sessionFile, '{"type":"message","id":"provider-error"}\n', "utf8");
    controller.refreshAfterOwnedSessionWrite();

    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    expect(controller.hasSessionTakeover()).toBe(false);
    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("still rejects external edits before the prompt stream lock is reacquired", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await fs.appendFile(sessionFile, '{"type":"message","id":"external"}\n', "utf8");

    await expect(controller.reacquireAfterPrompt()).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("still rejects external edits after the prompt stream lock is reacquired", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await controller.reacquireAfterPrompt();
    await fs.appendFile(
      sessionFile,
      '{"type":"message","id":"external-after-reacquire"}\n',
      "utf8",
    );

    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    expect(controller.hasSessionTakeover()).toBe(true);
    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("refreshes the prompt fence after an owned transcript mirror append", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        sessionKey: "agent:main:discord:channel:123",
        withSessionWriteLock: (operation) => controller.withSessionWriteLock(operation),
      },
      async () =>
        await runWithOwnedSessionTranscriptWriteLock(
          { sessionFile, sessionKey: "agent:main:discord:channel:123" },
          async () => {
            await fs.appendFile(sessionFile, '{"type":"message","id":"delivery-mirror"}\n', "utf8");
          },
        ),
    );
    await expect(controller.withSessionWriteLock(() => "finalize")).resolves.toBe("finalize");

    expect(controller.hasSessionTakeover()).toBe(false);
    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(3);
  });

  it("refreshes the prompt fence after an owned session manager append", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await fs.appendFile(sessionFile, '{"type":"message","id":"owned-session-manager"}\n', "utf8");
    controller.refreshAfterOwnedSessionWrite();

    await expect(controller.withSessionWriteLock(() => "finalize")).resolves.toBe("finalize");
    expect(controller.hasSessionTakeover()).toBe(false);
  });

  it("allows post-prompt writes after the prompt context publishes an owned transcript write", async () => {
    const sessionFile = await createTempSessionFile();
    const releases: string[] = [];
    const acquireSessionWriteLock = vi.fn(async () => ({
      release: vi.fn(async () => {
        releases.push("release");
      }),
    }));
    const firstController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await firstController.releaseForPrompt();

    const secondController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });
    const promptActiveSession = async (run: () => Promise<void>): Promise<void> =>
      await withOwnedSessionTranscriptWrites(
        {
          sessionFile,
          sessionKey: "agent:main:slack:channel:456",
          withSessionWriteLock: (operation, options) =>
            secondController.withSessionWriteLock(operation, options),
        },
        run,
      );
    await promptActiveSession(
      async () =>
        await runWithOwnedSessionTranscriptWritePublication(
          { sessionFile, sessionKey: "agent:main:slack:channel:456" },
          async () => {
            await fs.appendFile(sessionFile, '{"type":"message","id":"same-process"}\n', "utf8");
          },
        ),
    );
    await secondController.releaseForPrompt();

    await expect(
      firstController.withSessionWriteLock(async () => {
        await fs.appendFile(sessionFile, '{"type":"message","id":"post-prompt"}\n', "utf8");
        return "post-write";
      }),
    ).resolves.toBe("post-write");

    expect(firstController.hasSessionTakeover()).toBe(false);
    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(3);
    expect(releases).toEqual(["release", "release", "release"]);
  });

  it("rejects external edits interleaved while another controller holds cleanup lock", async () => {
    const sessionFile = await createTempSessionFile();
    const releases: string[] = [];
    const acquireSessionWriteLock = vi.fn(async () => ({
      release: vi.fn(async () => {
        releases.push("release");
      }),
    }));
    const firstController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await firstController.releaseForPrompt();

    const secondController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });
    await secondController.releaseForPrompt();
    const cleanupLock = await secondController.acquireForCleanup();

    await fs.appendFile(sessionFile, '{"type":"message","id":"external-cleanup"}\n', "utf8");
    await cleanupLock.release();

    await expect(
      firstController.withSessionWriteLock(async () => {
        await fs.appendFile(sessionFile, '{"type":"message","id":"late"}\n', "utf8");
      }),
    ).rejects.toBeInstanceOf(EmbeddedAttemptSessionTakeoverError);

    expect(firstController.hasSessionTakeover()).toBe(true);
    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(4);
    expect(releases).toEqual(["release", "release", "release", "release"]);
  });

  it("rejects external edits interleaved inside a broad owned transcript lock", async () => {
    const sessionFile = await createTempSessionFile();
    const releases: string[] = [];
    const acquireSessionWriteLock = vi.fn(async () => ({
      release: vi.fn(async () => {
        releases.push("release");
      }),
    }));
    const firstController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await firstController.releaseForPrompt();

    const secondController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        sessionKey: "agent:main:slack:channel:789",
        withSessionWriteLock: (operation, options) =>
          secondController.withSessionWriteLock(operation, options),
      },
      async () =>
        await runWithOwnedSessionTranscriptWriteLock(
          { sessionFile, sessionKey: "agent:main:slack:channel:789" },
          async () => {
            await fs.appendFile(
              sessionFile,
              '{"type":"message","id":"external-owned-scope"}\n',
              "utf8",
            );
            await runWithOwnedSessionTranscriptWritePublication(
              { sessionFile, sessionKey: "agent:main:slack:channel:789" },
              async () => {
                await fs.appendFile(
                  sessionFile,
                  '{"type":"message","id":"same-process"}\n',
                  "utf8",
                );
              },
            );
          },
        ),
    );
    await secondController.releaseForPrompt();

    await expect(
      firstController.withSessionWriteLock(async () => {
        await fs.appendFile(sessionFile, '{"type":"message","id":"late"}\n', "utf8");
      }),
    ).rejects.toBeInstanceOf(EmbeddedAttemptSessionTakeoverError);

    expect(firstController.hasSessionTakeover()).toBe(true);
    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(3);
    expect(releases).toEqual(["release", "release", "release"]);
  });

  it("rejects external edits interleaved during a broad same-process locked callback", async () => {
    const sessionFile = await createTempSessionFile();
    const releases: string[] = [];
    const acquireSessionWriteLock = vi.fn(async () => ({
      release: vi.fn(async () => {
        releases.push("release");
      }),
    }));
    const firstController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await firstController.releaseForPrompt();

    const secondController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });
    await secondController.withSessionWriteLock(async () => {
      await fs.appendFile(sessionFile, '{"type":"message","id":"same-process"}\n', "utf8");
      await fs.appendFile(sessionFile, '{"type":"message","id":"external-interleaved"}\n', "utf8");
    });
    await secondController.releaseForPrompt();

    await expect(
      firstController.withSessionWriteLock(async () => {
        await fs.appendFile(sessionFile, '{"type":"message","id":"late"}\n', "utf8");
      }),
    ).rejects.toBeInstanceOf(EmbeddedAttemptSessionTakeoverError);

    expect(firstController.hasSessionTakeover()).toBe(true);
    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(3);
    expect(releases).toEqual(["release", "release", "release"]);
  });

  it("rejects external session edits even when another controller releases for prompt afterward", async () => {
    const sessionFile = await createTempSessionFile();
    const releases: string[] = [];
    const acquireSessionWriteLock = vi.fn(async () => ({
      release: vi.fn(async () => {
        releases.push("release");
      }),
    }));
    const firstController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await firstController.releaseForPrompt();
    await fs.appendFile(sessionFile, '{"type":"message","id":"external"}\n', "utf8");

    const secondController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });
    await secondController.releaseForPrompt();

    await expect(
      firstController.withSessionWriteLock(async () => {
        await fs.appendFile(sessionFile, '{"type":"message","id":"late"}\n', "utf8");
      }),
    ).rejects.toBeInstanceOf(EmbeddedAttemptSessionTakeoverError);

    expect(firstController.hasSessionTakeover()).toBe(true);
    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(3);
    expect(releases).toEqual(["release", "release", "release"]);
  });

  it("rejects external session edits even when another controller appends under lock afterward", async () => {
    const sessionFile = await createTempSessionFile();
    const releases: string[] = [];
    const acquireSessionWriteLock = vi.fn(async () => ({
      release: vi.fn(async () => {
        releases.push("release");
      }),
    }));
    const firstController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await firstController.releaseForPrompt();
    await fs.appendFile(sessionFile, '{"type":"message","id":"external"}\n', "utf8");

    const secondController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });
    await secondController.withSessionWriteLock(async () => {
      await fs.appendFile(sessionFile, '{"type":"message","id":"same-process"}\n', "utf8");
    });
    await secondController.releaseForPrompt();

    await expect(
      firstController.withSessionWriteLock(async () => {
        await fs.appendFile(sessionFile, '{"type":"message","id":"late"}\n', "utf8");
      }),
    ).rejects.toBeInstanceOf(EmbeddedAttemptSessionTakeoverError);

    expect(firstController.hasSessionTakeover()).toBe(true);
    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(3);
    expect(releases).toEqual(["release", "release", "release"]);
  });

  it("returns a no-op cleanup lock after prompt lock reacquisition times out", async () => {
    const releases: string[] = [];
    const acquireSessionWriteLock = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => releases.push("prep")) })
      .mockRejectedValueOnce(
        new SessionWriteLockTimeoutError({
          timeoutMs: lockOptions.timeoutMs,
          owner: "pid=123",
          lockPath: `${lockOptions.sessionFile}.lock`,
        }),
      );

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions,
    });

    await controller.releaseForPrompt();
    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(2);
    expect(controller.hasSessionTakeover()).toBe(true);
    expect(releases).toEqual(["prep"]);
  });

  it("skips cleanup lock reacquisition after a post-prompt lock timeout", async () => {
    const releases: string[] = [];
    const acquireSessionWriteLock = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => releases.push("prep")) })
      .mockRejectedValueOnce(
        new SessionWriteLockTimeoutError({
          timeoutMs: lockOptions.timeoutMs,
          owner: "pid=456",
          lockPath: `${lockOptions.sessionFile}.lock`,
        }),
      );

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions,
    });

    await controller.releaseForPrompt();
    await expect(controller.withSessionWriteLock(() => "late-write")).rejects.toBeInstanceOf(
      SessionWriteLockTimeoutError,
    );
    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(2);
    expect(controller.hasSessionTakeover()).toBe(true);
    expect(releases).toEqual(["prep"]);
  });

  it("wraps provider stream submission with queued transcript drain and lock release", async () => {
    const events: string[] = [];
    const streamFn = vi.fn(async (..._args: unknown[]) => {
      events.push("stream");
    });
    const waitForSessionEvents = vi.fn(async () => {
      events.push("drain");
    });
    const releaseForPrompt = vi.fn(async () => {
      events.push("release");
    });
    const reacquireAfterPrompt = vi.fn(async () => {
      events.push("reacquire");
    });
    const session = { agent: { streamFn } };

    installPromptSubmissionLockRelease({
      session,
      waitForSessionEvents,
      releaseForPrompt,
      reacquireAfterPrompt,
    });

    await session.agent.streamFn("model", "context");

    expect(waitForSessionEvents).toHaveBeenCalledWith(session);
    expect(releaseForPrompt).toHaveBeenCalledTimes(1);
    expect(reacquireAfterPrompt).toHaveBeenCalledTimes(1);
    expect(streamFn).toHaveBeenCalledWith("model", "context");
    expect(events).toEqual(["drain", "release", "stream", "reacquire"]);
  });

  it("rewraps provider stream submission after the stream function is rebuilt", async () => {
    const events: string[] = [];
    const firstStreamFn = vi.fn(async (..._args: unknown[]) => {
      events.push("first-stream");
    });
    const secondStreamFn = vi.fn(async (..._args: unknown[]) => {
      events.push("second-stream");
    });
    const waitForSessionEvents = vi.fn(async () => {
      events.push("drain");
    });
    const releaseForPrompt = vi.fn(async () => {
      events.push("release");
    });
    const reacquireAfterPrompt = vi.fn(async () => {
      events.push("reacquire");
    });
    const session = { agent: { streamFn: firstStreamFn } };

    installPromptSubmissionLockRelease({
      session,
      waitForSessionEvents,
      releaseForPrompt,
      reacquireAfterPrompt,
    });
    installPromptSubmissionLockRelease({
      session,
      waitForSessionEvents,
      releaseForPrompt,
      reacquireAfterPrompt,
    });
    await session.agent.streamFn("first-model");

    session.agent.streamFn = secondStreamFn;
    installPromptSubmissionLockRelease({
      session,
      waitForSessionEvents,
      releaseForPrompt,
      reacquireAfterPrompt,
    });
    await session.agent.streamFn("second-model");

    expect(firstStreamFn).toHaveBeenCalledTimes(1);
    expect(secondStreamFn).toHaveBeenCalledTimes(1);
    expect(waitForSessionEvents).toHaveBeenCalledTimes(2);
    expect(releaseForPrompt).toHaveBeenCalledTimes(2);
    expect(reacquireAfterPrompt).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      "drain",
      "release",
      "first-stream",
      "reacquire",
      "drain",
      "release",
      "second-stream",
      "reacquire",
    ]);
  });

  it("locks agent events that can reach transcript writers or registered extension hooks", async () => {
    const releases: string[] = [];
    const acquireSessionWriteLock = vi.fn(async (_options: typeof lockOptions) => ({
      release: vi.fn(async () => {
        releases.push("released");
      }),
    }));
    const processed: Array<string | undefined> = [];
    const hasHandlers = vi.fn(() => false);
    const session = {
      _extensionRunner: { hasHandlers },
      _processAgentEvent: vi.fn(async (event: { type?: string }) => {
        processed.push(event.type);
      }),
    };

    installSessionEventWriteLock({
      session,
      withSessionWriteLock: async (run) => {
        const lock = await acquireSessionWriteLock(lockOptions);
        try {
          return await run();
        } finally {
          await lock.release();
        }
      },
    });

    await session._processAgentEvent({ type: "message_update" });
    await session._processAgentEvent({ type: "tool_execution_end" });
    await session._processAgentEvent({ type: "message_end" });
    await session._processAgentEvent({ type: "agent_end" });
    await session._processAgentEvent({});

    expect(processed).toEqual([
      "message_update",
      "tool_execution_end",
      "message_end",
      "agent_end",
      undefined,
    ]);
    expect(hasHandlers).toHaveBeenCalledWith("tool_execution_end");
    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(3);
    expect(acquireSessionWriteLock).toHaveBeenCalledWith(lockOptions);
    expect(releases).toEqual(["released", "released", "released"]);
  });

  it("locks Pi extension hooks that can mutate the session outside agent events", async () => {
    const locked: string[] = [];
    const called: string[] = [];
    const hasHandlers = vi.fn(
      (eventType: string) =>
        eventType === "tool_call" ||
        eventType === "tool_result" ||
        eventType === "before_provider_request",
    );
    const session = {
      _extensionRunner: { hasHandlers },
      compact: vi.fn(async () => called.push("compact")),
      agent: {
        beforeToolCall: vi.fn(async () => called.push("tool_call")),
        afterToolCall: vi.fn(async () => called.push("tool_result")),
        onPayload: vi.fn(async () => {
          called.push("before_provider_request");
          return { ok: true };
        }),
        onResponse: vi.fn(async () => called.push("after_provider_response")),
      },
    };

    installSessionExternalHookWriteLock({
      session,
      withSessionWriteLock: async (run) => {
        locked.push("lock");
        return await run();
      },
    });

    await session.agent.beforeToolCall();
    await session.agent.afterToolCall();
    await expect(session.agent.onPayload()).resolves.toEqual({ ok: true });
    await session.agent.onResponse();
    await session.compact();

    expect(called).toEqual([
      "tool_call",
      "tool_result",
      "before_provider_request",
      "after_provider_response",
      "compact",
    ]);
    expect(locked).toEqual(["lock", "lock", "lock", "lock"]);
    expect(hasHandlers).toHaveBeenCalledWith("tool_result");
    expect(hasHandlers).toHaveBeenCalledWith("before_provider_request");
    expect(hasHandlers).toHaveBeenCalledWith("after_provider_response");
  });

  it("fences tool calls even when no extension hook is registered", async () => {
    const events: string[] = [];
    const session = {
      _extensionRunner: {
        hasHandlers: vi.fn(() => false),
      },
      agent: {
        beforeToolCall: vi.fn(async () => {
          events.push("tool_call");
        }),
      },
    };

    installSessionExternalHookWriteLock({
      session,
      withSessionWriteLock: async (run) => {
        events.push("lock");
        return await run();
      },
    });

    await session.agent.beforeToolCall();

    expect(events).toEqual(["lock", "tool_call"]);
    expect(session._extensionRunner.hasHandlers).not.toHaveBeenCalledWith("tool_call");
  });

  it("accepts pi-style writes published via publishOwnedPostMessageWrite before beforeToolCall fires", async () => {
    // Regression for #86572: when pi's _persist path appends to the session
    // file via appendFileSync between releaseForPrompt and the next external
    // hook firing, publishOwnedPostMessageWrite (called from the
    // onMessagePersisted callback with the pre-append fingerprint) records
    // the post-write fingerprint as an OWNED write so the subsequent
    // assertSessionFileFence accepts the lane's own writes via the
    // owned-write match path.
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    const toolCallFired: string[] = [];
    const session = {
      agent: {
        beforeToolCall: vi.fn(async () => {
          toolCallFired.push("tool-call");
        }),
      },
    };

    installSessionExternalHookWriteLock({
      session,
      withSessionWriteLock: (op) => controller.withSessionWriteLock(op),
    });

    // Mimic the prompt-window lifecycle: release for prompt (captures F0 +
    // marks it trusted), capture pre-write fingerprint F0, pi writes
    // directly via appendFileSync (F0->F1), then pi synchronously fires
    // onMessagePersisted which calls publishOwnedPostMessageWrite(F0) to
    // record F1 as owned because F0 is still trusted.
    await controller.releaseForPrompt();
    const beforeWrite = readSessionFileFingerprintSync(sessionFile);
    await fs.appendFile(sessionFile, '{"type":"message","id":"pi-stream-write"}\n', "utf8");
    controller.publishOwnedPostMessageWrite(beforeWrite);

    // beforeToolCall fires after the publish. assertSessionFileFence sees the
    // owned-write match and accepts the lane's own write.
    await expect(session.agent.beforeToolCall()).resolves.toBeUndefined();
    expect(toolCallFired).toEqual(["tool-call"]);
    expect(controller.hasSessionTakeover()).toBe(false);
  });

  it("accepts pi-style writes after a lock-mediated prompt write refreshed the active fence", async () => {
    // A legitimate locked write can advance the active fence without going
    // through the global trusted-state map. A later pi append whose pre-write
    // fingerprint matches that active fence is still part of this lane.
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    const beforeToolCallSpy = vi.fn(async () => {});
    const session = {
      agent: { beforeToolCall: beforeToolCallSpy },
    };

    installSessionExternalHookWriteLock({
      session,
      withSessionWriteLock: (op) => controller.withSessionWriteLock(op),
    });

    await controller.releaseForPrompt();
    await controller.withSessionWriteLock(async () => {
      await fs.appendFile(sessionFile, '{"type":"message","id":"locked-owned"}\n', "utf8");
    });

    const beforeWrite = readSessionFileFingerprintSync(sessionFile);
    await fs.appendFile(sessionFile, '{"type":"message","id":"pi-after-locked"}\n', "utf8");
    controller.publishOwnedPostMessageWrite(beforeWrite);

    await expect(session.agent.beforeToolCall()).resolves.toBeUndefined();
    expect(beforeToolCallSpy).toHaveBeenCalledTimes(1);
    expect(controller.hasSessionTakeover()).toBe(false);
  });

  it("accepts pi-style writes after a benign delivery-mirror append advanced the released fence", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    const beforeToolCallSpy = vi.fn(async () => {});
    const session = {
      agent: { beforeToolCall: beforeToolCallSpy },
    };

    installSessionExternalHookWriteLock({
      session,
      withSessionWriteLock: (op) => controller.withSessionWriteLock(op),
    });

    await controller.releaseForPrompt();
    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "mirrored media delivery" }],
        provider: "openclaw",
        model: "delivery-mirror",
      },
    });

    const beforeWrite = readSessionFileFingerprintSync(sessionFile);
    await fs.appendFile(sessionFile, '{"type":"message","id":"pi-after-mirror"}\n', "utf8");
    controller.publishOwnedPostMessageWrite(beforeWrite);

    await expect(session.agent.beforeToolCall()).resolves.toBeUndefined();
    expect(beforeToolCallSpy).toHaveBeenCalledTimes(1);
    expect(controller.hasSessionTakeover()).toBe(false);
  });

  it("trips takeover on a same-file external write that bypasses publishOwnedPostMessageWrite", async () => {
    // Negative companion. If an external mutation advances the session file
    // WITHOUT going through pi's _persist -> onMessagePersisted ->
    // publishOwnedPostMessageWrite chain, the write is never recorded in
    // ownedSessionFileWrites and assertSessionFileFence must fail closed.
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    const session = {
      agent: {
        beforeToolCall: vi.fn(async () => {}),
      },
    };

    installSessionExternalHookWriteLock({
      session,
      withSessionWriteLock: (op) => controller.withSessionWriteLock(op),
    });

    await controller.releaseForPrompt();
    // External mutation: NO publishOwnedPostMessageWrite() call follows.
    await fs.appendFile(sessionFile, '{"type":"message","id":"external-write"}\n', "utf8");

    await expect(session.agent.beforeToolCall()).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
  });

  it("trips takeover on a mixed external-then-pi append (publish refuses to launder external mutation)", async () => {
    // The mixed-interleaving case ClawSweeper explicitly required:
    //   1. releaseForPrompt() captures F0, marks F0 trusted.
    //   2. External lane appends (F0 -> F1).
    //   3. Pi captures pre-append fingerprint = F1.
    //   4. Pi appends (F1 -> F2).
    //   5. Pi calls publishOwnedPostMessageWrite(F1).
    //
    // The publish must REFUSE to record F2 as owned because F1 is not in
    // trustedSessionFileStates (only F0 is). Without this gate, the combined
    // current state (F2 = external + pi writes) would be recorded as owned
    // and a subsequent external write or hook lock check would launder the
    // external mutation through the owned-write match path.
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    const session = {
      agent: {
        beforeToolCall: vi.fn(async () => {}),
      },
    };

    installSessionExternalHookWriteLock({
      session,
      withSessionWriteLock: (op) => controller.withSessionWriteLock(op),
    });

    await controller.releaseForPrompt();
    // External mutation first (F0 -> F1).
    await fs.appendFile(sessionFile, '{"type":"message","id":"external-first"}\n', "utf8");
    // Pi captures pre-append = F1 (post-external state).
    const beforeWrite = readSessionFileFingerprintSync(sessionFile);
    // Pi appends its own message (F1 -> F2).
    await fs.appendFile(sessionFile, '{"type":"message","id":"pi-after-external"}\n', "utf8");
    // Pi calls publish with the F1 baseline. The gate must REFUSE because
    // F1 was never trusted — only F0 was.
    controller.publishOwnedPostMessageWrite(beforeWrite);

    // The hook lock must still trip on the combined state.
    await expect(session.agent.beforeToolCall()).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
  });

  it("allows multiple prompt turns with pi-style writes published per turn", async () => {
    // Regression for #86572 multi-turn case: each continuation captures its
    // own fenceFingerprint at releaseForPrompt; publishOwnedPostMessageWrite
    // must work independently per turn without leaking state across them.
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });
    // Capture the original spy before installLockableFunction replaces
    // session.agent.beforeToolCall with the lock wrapper.
    const beforeToolCallSpy = vi.fn(async () => {});
    const session = {
      agent: { beforeToolCall: beforeToolCallSpy },
    };
    installSessionExternalHookWriteLock({
      session,
      withSessionWriteLock: (op) => controller.withSessionWriteLock(op),
    });

    for (let turn = 0; turn < 3; turn += 1) {
      await controller.releaseForPrompt();
      const beforeWrite = readSessionFileFingerprintSync(sessionFile);
      await fs.appendFile(sessionFile, `{"type":"message","id":"turn-${turn}"}\n`, "utf8");
      controller.publishOwnedPostMessageWrite(beforeWrite);
      await expect(session.agent.beforeToolCall()).resolves.toBeUndefined();
      await controller.reacquireAfterPrompt();
    }

    expect(controller.hasSessionTakeover()).toBe(false);
    expect(beforeToolCallSpy).toHaveBeenCalledTimes(3);
  });

  it("does not classify a different session file's writes as owned by this controller", async () => {
    // Cross-file isolation: publishOwnedPostMessageWrite reads THIS
    // controller's sessionFile, so a write to a different file is invisible
    // to it. Calling publish with file A's pre-write fingerprint after a
    // write to file B leaves controllerA's fence untouched, and a subsequent
    // genuine external write to file A must still trip the fence.
    const sessionFileA = await createTempSessionFile();
    const sessionFileB = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controllerA = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile: sessionFileA },
    });

    await controllerA.releaseForPrompt();
    const beforeWriteA = readSessionFileFingerprintSync(sessionFileA);

    // Write to file B only. File A is unchanged.
    await fs.appendFile(sessionFileB, '{"type":"message","id":"file-b-write"}\n', "utf8");

    // publishOwnedPostMessageWrite reads sessionFileA's stat. File A is
    // unchanged so the post-write fingerprint matches beforeWriteA — no-op.
    controllerA.publishOwnedPostMessageWrite(beforeWriteA);
    await expect(controllerA.withSessionWriteLock(() => "a-1")).resolves.toBe("a-1");

    // Now a genuine external write to file A must still trip the fence.
    await fs.appendFile(sessionFileA, '{"type":"message","id":"external-a"}\n', "utf8");
    await expect(controllerA.withSessionWriteLock(() => "a-2")).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controllerA.hasSessionTakeover()).toBe(true);
  });

  it("does not hang when reacquireAfterPrompt rejects after a pi-style direct write", async () => {
    // Regression for #86572 abort/error path: if an unowned write does
    // genuinely happen and reacquireAfterPrompt's fence trips, the cleanup
    // path must still terminate without hangs or unresolved promises.
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    // External (unowned) write — not from this lane.
    await fs.appendFile(sessionFile, '{"type":"message","id":"external-write"}\n', "utf8");

    await expect(controller.reacquireAfterPrompt()).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);

    // Cleanup must still terminate; acquireForCleanup returns a noop lock
    // once takeover is detected, so .release() never blocks.
    const cleanupLock = await controller.acquireForCleanup();
    await expect(cleanupLock.release()).resolves.toBeUndefined();
  });

  it("drains queued session events before locking a tool-call extension hook", async () => {
    const events: string[] = [];
    let resolveQueue!: () => void;
    const session = {
      _agentEventQueue: new Promise<void>((resolve) => {
        resolveQueue = resolve;
      }).then(() => {
        events.push("queue-drained");
      }),
      _extensionRunner: {
        hasHandlers: vi.fn((eventType: string) => eventType === "tool_call"),
      },
      agent: {
        beforeToolCall: vi.fn(async () => {
          events.push("hook-start");
          await session._agentEventQueue;
          events.push("hook-end");
        }),
      },
    };

    installSessionExternalHookWriteLock({
      session,
      withSessionWriteLock: async (run) => {
        events.push("lock");
        return await run();
      },
    });

    const hookPromise = session.agent.beforeToolCall();
    await Promise.resolve();
    expect(events).toEqual([]);

    resolveQueue();
    await hookPromise;

    expect(events).toEqual(["queue-drained", "lock", "hook-start", "hook-end"]);
  });
});
