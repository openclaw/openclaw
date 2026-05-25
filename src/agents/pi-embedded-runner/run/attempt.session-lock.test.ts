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
  acquireSessionWriteLock,
  resetSessionWriteLockStateForTest,
} from "../../session-write-lock.js";
import {
  createEmbeddedAttemptSessionLockController,
  EmbeddedAttemptSessionTakeoverError,
  installPromptSubmissionLockRelease,
  installSessionEventWriteLock,
  installSessionExternalHookWriteLock,
  resetEmbeddedAttemptSessionFilePromptGuardsForTest,
} from "./attempt.session-lock.js";

const lockOptions = {
  sessionFile: "/tmp/session.jsonl",
  timeoutMs: 60_000,
  staleMs: 1_800_000,
  maxHoldMs: 300_000,
};

const tempDirs: string[] = [];

afterEach(async () => {
  resetSessionWriteLockStateForTest();
  resetEmbeddedAttemptSessionFilePromptGuardsForTest();
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

  it("allows delivery mirror appends while the prompt lock is released", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
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

    await expect(controller.withSessionWriteLock(() => "late-write")).resolves.toBe("late-write");
    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    expect(controller.hasSessionTakeover()).toBe(false);
    expect(release).toHaveBeenCalledTimes(3);
  });

  it("allows delivery mirror appends that migrate legacy linear transcripts", async () => {
    const sessionFile = await createTempSessionFile();
    await fs.appendFile(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        id: "legacy-user",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      })}\n`,
      "utf8",
    );
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "mirrored migrated media delivery" }],
        provider: "openclaw",
        model: "delivery-mirror",
      },
    });

    await expect(controller.withSessionWriteLock(() => "late-write")).resolves.toBe("late-write");
    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    await expect(fs.readFile(sessionFile, "utf8")).resolves.toContain('"parentId"');
    expect(controller.hasSessionTakeover()).toBe(false);
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
    resetEmbeddedAttemptSessionFilePromptGuardsForTest();
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
    resetEmbeddedAttemptSessionFilePromptGuardsForTest();
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
    resetEmbeddedAttemptSessionFilePromptGuardsForTest();
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
    resetEmbeddedAttemptSessionFilePromptGuardsForTest();
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
    resetEmbeddedAttemptSessionFilePromptGuardsForTest();
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
    resetEmbeddedAttemptSessionFilePromptGuardsForTest();
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

  it("treats transcript appends during prompt streaming as owned session writes", async () => {
    const sessionFile = await createTempSessionFile();
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: {
        ...lockOptions,
        sessionFile,
        timeoutMs: 1_000,
      },
    });
    const session = {
      agent: {
        streamFn: vi.fn(async (..._args: unknown[]) => {
          await appendSessionTranscriptMessage({
            transcriptPath: sessionFile,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "mirrored message-tool delivery" }],
            },
          });
        }),
      },
    };

    installPromptSubmissionLockRelease({
      session,
      waitForSessionEvents: (sessionToDrain) => controller.waitForSessionEvents(sessionToDrain),
      releaseForPrompt: () => controller.releaseForPrompt(),
      reacquireAfterPrompt: () => controller.reacquireAfterPrompt(),
      sessionFile,
      withSessionWriteLock: (run) => controller.withSessionWriteLock(run),
    });

    await session.agent.streamFn("model", "context");
    const cleanupLock = await controller.acquireForCleanup({ session });
    await cleanupLock.release();

    expect(controller.hasSessionTakeover()).toBe(false);
    await expect(fs.readFile(sessionFile, "utf8")).resolves.toContain(
      "mirrored message-tool delivery",
    );
  });

  it("keeps prompt-stream transcript appends from blocking session-locked hook writes", async () => {
    const sessionFile = await createTempSessionFile();
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: {
        ...lockOptions,
        sessionFile,
        timeoutMs: 250,
      },
    });
    await controller.releaseForPrompt();

    let releaseHookAppend!: () => void;
    const hookCanAppend = new Promise<void>((resolve) => {
      releaseHookAppend = resolve;
    });
    let markHookHasLock!: () => void;
    const hookHasLock = new Promise<void>((resolve) => {
      markHookHasLock = resolve;
    });

    const hookAppend = controller.withSessionWriteLock(async () => {
      markHookHasLock();
      await hookCanAppend;
      await appendSessionTranscriptMessage({
        transcriptPath: sessionFile,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "session-locked hook write" }],
        },
      });
    });
    await hookHasLock;

    const promptAppend = withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        withSessionWriteLock: (run, options) => controller.withSessionWriteLock(run, options),
      },
      async () =>
        await appendSessionTranscriptMessage({
          transcriptPath: sessionFile,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "prompt-stream write" }],
          },
        }),
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    releaseHookAppend();
    await Promise.all([hookAppend, promptAppend]);

    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    const transcript = await fs.readFile(sessionFile, "utf8");
    expect(transcript).toContain("session-locked hook write");
    expect(transcript).toContain("prompt-stream write");
    expect(controller.hasSessionTakeover()).toBe(false);
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

    await session["_processAgentEvent"]({ type: "message_update" });
    await session["_processAgentEvent"]({ type: "tool_execution_end" });
    await session["_processAgentEvent"]({ type: "message_end" });
    await session["_processAgentEvent"]({ type: "agent_end" });
    await session["_processAgentEvent"]({});

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

  it("makes the Pi event listener await locked session event processing", async () => {
    const events: string[] = [];
    const session = {
      _agentEventQueue: Promise.resolve(),
      _disconnectFromAgent: vi.fn(() => events.push("disconnect")),
      _reconnectToAgent: vi.fn(() => events.push("reconnect")),
      _processAgentEvent: vi.fn(async (event: { type?: string }) => {
        events.push(`process:${event.type}`);
      }),
      _handleAgentEvent(event: { type?: string }) {
        events.push(`handle:${event.type}`);
        session["_agentEventQueue"] = session["_agentEventQueue"].then(() =>
          session["_processAgentEvent"](event),
        );
        session["_agentEventQueue"].catch(() => {});
      },
    };

    installSessionEventWriteLock({
      session,
      withSessionWriteLock: async (run) => {
        events.push("lock");
        return await run();
      },
    });

    const handleAgentEvent = session["_handleAgentEvent"];
    const result = handleAgentEvent({ type: "message_end" }) as unknown as Promise<unknown>;

    expect(result).toHaveProperty("then");
    expect(events).toEqual(["disconnect", "reconnect", "handle:message_end"]);

    await result;

    expect(events).toEqual([
      "disconnect",
      "reconnect",
      "handle:message_end",
      "lock",
      "process:message_end",
    ]);
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
    expect(session["_extensionRunner"].hasHandlers).not.toHaveBeenCalledWith("tool_call");
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
          await session["_agentEventQueue"];
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

  it("serialises prompt windows on the same session file across two controllers", async () => {
    const sessionFile = await createTempSessionFile();
    const events: string[] = [];
    let acquireCount = 0;
    const acquireSessionWriteLock = vi.fn(async () => {
      acquireCount += 1;
      const id = acquireCount;
      events.push(`acquire-${id}`);
      return {
        release: vi.fn(async () => {
          events.push(`release-${id}`);
        }),
      };
    });

    const firstController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });
    const secondController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await firstController.releaseForPrompt();

    let secondCompletedRelease = false;
    const secondReleasePromise = secondController.releaseForPrompt().then(() => {
      secondCompletedRelease = true;
    });
    // Yield several microtasks; the second release must still be blocked
    // because the first controller has not yet reacquired its prompt turn.
    await Promise.resolve();
    await Promise.resolve();
    expect(secondCompletedRelease).toBe(false);

    await firstController.reacquireAfterPrompt();
    await secondReleasePromise;

    expect(secondCompletedRelease).toBe(true);
    expect(firstController.hasSessionTakeover()).toBe(false);
    expect(secondController.hasSessionTakeover()).toBe(false);
  });

  it("vacates the prompt turn so later waiters proceed when reacquireAfterPrompt throws", async () => {
    // Regression for the file-scoped guard's cleanup-on-failure path. If
    // reacquireAfterPrompt's error branch did not release the turn, the
    // next same-file waiter would block forever — i.e. one failed prompt
    // window would wedge the session file for the rest of the process.
    const sessionFile = await createTempSessionFile();
    const events: string[] = [];

    const firstInitialRelease = vi.fn(async () => {
      events.push("first-initial-release");
    });
    const secondInitialRelease = vi.fn(async () => {
      events.push("second-initial-release");
    });
    const secondReacquireRelease = vi.fn(async () => {
      events.push("second-reacquire-release");
    });

    const acquireSessionWriteLock = vi.fn();
    acquireSessionWriteLock
      .mockResolvedValueOnce({ release: firstInitialRelease })
      .mockResolvedValueOnce({ release: secondInitialRelease })
      // First controller's reacquireAfterPrompt rejects with a real
      // lock-timeout error (the same shape the production code would see if
      // another process or lane held the lock past timeoutMs).
      .mockRejectedValueOnce(
        new SessionWriteLockTimeoutError({
          timeoutMs: lockOptions.timeoutMs,
          owner: "pid=external",
          lockPath: `${sessionFile}.lock`,
        }),
      )
      .mockResolvedValueOnce({ release: secondReacquireRelease });

    const firstController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });
    const secondController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await firstController.releaseForPrompt();

    let secondCompletedRelease = false;
    const secondReleasePromise = secondController.releaseForPrompt().then(() => {
      secondCompletedRelease = true;
    });
    await Promise.resolve();
    expect(secondCompletedRelease).toBe(false);

    await expect(firstController.reacquireAfterPrompt()).rejects.toBeInstanceOf(
      SessionWriteLockTimeoutError,
    );

    // The first turn must have been released by reacquireAfterPrompt's
    // finally block, even though the body threw. The second waiter is now
    // free to proceed through its own release-for-prompt.
    await secondReleasePromise;
    expect(secondCompletedRelease).toBe(true);

    // The second controller observes a clean prompt window; the file-scoped
    // queue did not get wedged by the first lane's failed reacquire.
    expect(secondController.hasSessionTakeover()).toBe(false);
  });

  it("vacates the prompt turn when releaseForPrompt itself fails mid-flight", async () => {
    // Regression for the same cleanup-on-failure path on the other side of
    // the prompt window. If releaseForPrompt throws partway — for example
    // the held lock's release rejects — the turn slot must still be
    // vacated. Otherwise the next same-file waiter blocks forever even
    // though no prompt is actually in flight.
    const sessionFile = await createTempSessionFile();

    const firstInitialRelease = vi.fn(async () => {
      throw new Error("simulated lock-release failure");
    });
    const secondInitialRelease = vi.fn(async () => {});
    const secondReacquireRelease = vi.fn(async () => {});
    const thirdInitialRelease = vi.fn(async () => {});

    const acquireSessionWriteLock = vi.fn();
    acquireSessionWriteLock
      // First and second start with their own locks; the second is
      // blocked waiting on the first's turn at the point first throws.
      .mockResolvedValueOnce({ release: firstInitialRelease })
      .mockResolvedValueOnce({ release: secondInitialRelease })
      // The second controller's prior-wait dance reacquires here after
      // the first turn vacates on its release failure.
      .mockResolvedValueOnce({ release: secondReacquireRelease })
      .mockResolvedValueOnce({ release: thirdInitialRelease });

    const firstController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });
    const secondController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    // First controller's releaseForPrompt now reaches lock.release() which
    // rejects. The turn must be vacated by the catch block.
    await expect(firstController.releaseForPrompt()).rejects.toThrow(
      "simulated lock-release failure",
    );

    // Second controller's releaseForPrompt must complete without blocking
    // on a dangling turn from the failed first release.
    await secondController.releaseForPrompt();
    expect(secondController.hasSessionTakeover()).toBe(false);
  });

  it("does not block prompt-window waiters behind a compaction-wait release on the same file", async () => {
    // releaseForSessionIdleWait is for the post-prompt compaction window;
    // it must not register a prompt-turn or other lanes will wait on it
    // unnecessarily.
    const sessionFile = await createTempSessionFile();
    const events: string[] = [];
    let acquireCount = 0;
    const acquireSessionWriteLock = vi.fn(async () => {
      acquireCount += 1;
      const id = acquireCount;
      events.push(`acquire-${id}`);
      return {
        release: vi.fn(async () => {
          events.push(`release-${id}`);
        }),
      };
    });

    const firstController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });
    const secondController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await firstController.releaseForSessionIdleWait();

    // Second controller's prompt window should run without waiting on
    // anything from the idle-wait release.
    await secondController.releaseForPrompt();

    expect(firstController.hasSessionTakeover()).toBe(false);
    expect(secondController.hasSessionTakeover()).toBe(false);
  });

  it("does not serialise prompt windows across different session files", async () => {
    const sessionFileA = await createTempSessionFile();
    const sessionFileB = await createTempSessionFile();
    const acquireSessionWriteLock = vi.fn(async () => ({
      release: vi.fn(async () => {}),
    }));

    const controllerA = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile: sessionFileA },
    });
    const controllerB = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile: sessionFileB },
    });

    await controllerA.releaseForPrompt();
    // B's prompt window targets a different session file — it must not
    // block on A's outstanding turn.
    await controllerB.releaseForPrompt();
    expect(controllerB.hasSessionTakeover()).toBe(false);
  });

  it("dispose-after-releaseForPrompt vacates the prompt turn so the next same-file controller does not hang", async () => {
    // Regression for the ClawSweeper P2 finding on #86067: after
    // releaseForPrompt() opens the prompt window, heldLock is undefined but
    // activePromptSessionTurn is still set until reacquireAfterPrompt clears
    // it. If teardown runs in that window (mid-stream throw, etc.), dispose
    // must release+clear the prompt turn or the file-scoped queue tail
    // never resolves and the next same-file controller waits forever.
    resetEmbeddedAttemptSessionFilePromptGuardsForTest();
    const sessionFile = await createTempSessionFile();
    const acquireSessionWriteLock = vi.fn(async () => ({
      release: vi.fn(async () => {}),
    }));
    const controllerA = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controllerA.releaseForPrompt();
    // Teardown without going through reacquireAfterPrompt — the case the
    // outer-finally `releaseRetainedSessionLock?.()` covers when the prompt
    // stream throws.
    await controllerA.dispose();
    // Idempotent: second dispose must be safe (the outer finally can run
    // even after acquireForCleanup has handed off the lock).
    await controllerA.dispose();

    // A new controller on the same file must be able to open its own
    // prompt window without hanging on A's vacated turn.
    const controllerB = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });
    await expect(
      Promise.race([
        controllerB.releaseForPrompt().then(() => "released"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 200)),
      ]),
    ).resolves.toBe("released");
    expect(controllerB.hasSessionTakeover()).toBe(false);
  });
});
