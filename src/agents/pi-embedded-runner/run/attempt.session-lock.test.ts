import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionWriteLockTimeoutError } from "../../session-write-lock-error.js";
import {
  createEmbeddedAttemptSessionLockController,
  EmbeddedAttemptSessionTakeoverError,
  installPromptSubmissionLockRelease,
  installSessionEventWriteLock,
  installSessionExternalHookWriteLock,
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

  it("rejects post-prompt writes when another owner queues a new user turn", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    await fs.appendFile(
      sessionFile,
      '{"type":"message","id":"takeover","message":{"role":"user","content":"new turn"}}\n',
      "utf8",
    );

    await expect(controller.withSessionWriteLock(() => "late-write")).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);

    const cleanupLock = await controller.acquireForCleanup();
    await cleanupLock.release();

    expect(release).toHaveBeenCalledTimes(2);
  });

  it("accepts post-prompt writes when only the runner's own transcript entries appear", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    // Runner-owned writers (e.g. appendSessionTranscriptMessageLocked via
    // allowReentrant:true) append assistant replies and persisted tool outputs
    // during the released-lock window. These must not trip the takeover fence.
    // Persisted role names follow isAgentMessage in transcript-file-state.ts.
    await fs.appendFile(
      sessionFile,
      '{"type":"message","id":"assistant-1","message":{"role":"assistant","content":"calling tool"}}\n',
      "utf8",
    );
    await fs.appendFile(
      sessionFile,
      '{"type":"message","id":"toolresult-1","message":{"role":"toolResult","toolCallId":"call-1","toolName":"exec","isError":false,"content":[{"type":"text","text":"ok"}]}}\n',
      "utf8",
    );
    await fs.appendFile(
      sessionFile,
      '{"type":"message","id":"bash-1","message":{"role":"bashExecution","command":"ls","output":"","exitCode":0,"cancelled":false,"truncated":false}}\n',
      "utf8",
    );

    await expect(controller.withSessionWriteLock(() => "late-write")).resolves.toBe("late-write");
    expect(controller.hasSessionTakeover()).toBe(false);
  });

  it("rejects post-prompt writes when an accepted runner-owned role is malformed", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    // toolResult requires toolCallId, toolName, isError, and array content
    // per the persisted message contract. An entry that carries the role
    // but omits required fields is not a real runner-owned write and must
    // trip the takeover fence.
    await fs.appendFile(
      sessionFile,
      '{"type":"message","id":"malformed-1","message":{"role":"toolResult","toolCallId":"call-1"}}\n',
      "utf8",
    );

    await expect(controller.withSessionWriteLock(() => "late-write")).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
  });

  it("rejects post-prompt writes when a runner-owned message entry omits id", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    // Canonical persisted session entries require a non-empty string id. An
    // appended assistant message that omits the outer entry base is not a
    // valid runner-owned write and must trip the takeover fence, matching
    // the behavior current main exhibits via its stat-mismatch path.
    await fs.appendFile(
      sessionFile,
      '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}\n',
      "utf8",
    );

    await expect(controller.withSessionWriteLock(() => "late-write")).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
  });

  it("rejects post-prompt writes when a non-message entry is appended", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    // Custom/compaction/branch_summary entries are session-state mutations
    // outside the runner-owned transcript-write path. Appending one during the
    // released-lock window must trip the takeover fence even though it grew
    // the file append-only and no user-role entry appeared.
    await fs.appendFile(
      sessionFile,
      '{"type":"custom","id":"custom-1","customType":"branch_marker","data":{}}\n',
      "utf8",
    );

    await expect(controller.withSessionWriteLock(() => "late-write")).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
  });

  it("rejects post-prompt writes when a tail line parses to a non-object value", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    // A literal JSON null parses cleanly but is not a session entry. The
    // slow path must fail closed as takeover rather than letting the
    // canonical validator dereference a non-object.
    await fs.appendFile(sessionFile, "null\n", "utf8");

    await expect(controller.withSessionWriteLock(() => "late-write")).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
  });

  it("keeps the fence consistent when a guarded operation throws after assertion", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    const assistantEntry = (id: string) =>
      `{"type":"message","id":"${id}","parentId":null,"timestamp":"2026-05-19T00:00:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"x"}]}}\n`;

    await controller.releaseForPrompt();
    // First append-then-assert advances the fence over a runner-owned tail.
    // The guarded operation then throws, which skips refreshSessionFileFence
    // and used to leave the snapshot describing the new size but holding
    // the old prefix hash. A second runner-owned append would then false-
    // positive on prefix-hash mismatch in the next slow path.
    await fs.appendFile(sessionFile, assistantEntry("a1"), "utf8");
    await expect(
      controller.withSessionWriteLock(() => {
        throw new Error("post-assert");
      }),
    ).rejects.toThrow("post-assert");
    expect(controller.hasSessionTakeover()).toBe(false);

    await fs.appendFile(sessionFile, assistantEntry("a2"), "utf8");
    await expect(controller.withSessionWriteLock(() => "ok")).resolves.toBe("ok");
    expect(controller.hasSessionTakeover()).toBe(false);
  });

  it("refuses to bless a snapshot when the file is rewritten in place during snapshot creation", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    // Simulate a same-size in-place rewrite landing between snapshot's stat
    // and its read. Spy on fs.readFile so the very first call (made during
    // releaseForPrompt's snapshot) atomically rewrites the file with new
    // content of identical byte length before delegating to the real read.
    // The post-read re-stat then sees a different mtime/ctime and the
    // snapshot returns prefixHashHex: null, which makes the next
    // withSessionWriteLock fail closed even on an otherwise valid append.
    const originalSize = (await fs.stat(sessionFile)).size;
    const rewritten = Buffer.alloc(originalSize, 0x78); // same length, different content
    const readFileSpy = vi.spyOn(fs, "readFile");
    readFileSpy.mockImplementationOnce(async (target) => {
      readFileSpy.mockRestore();
      await fs.writeFile(target as string, rewritten);
      return fs.readFile(target as string);
    });

    try {
      await controller.releaseForPrompt();
      await fs.appendFile(
        sessionFile,
        '{"type":"message","id":"a1","parentId":null,"timestamp":"2026-05-19T00:00:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"x"}]}}\n',
        "utf8",
      );

      await expect(controller.withSessionWriteLock(() => "late-write")).rejects.toBeInstanceOf(
        EmbeddedAttemptSessionTakeoverError,
      );
      expect(controller.hasSessionTakeover()).toBe(true);
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("refuses to bless a slow-path verification when the file is rewritten in place during the slow-path read", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    // Snapshot the fence cleanly first, then inject the race during the
    // slow path's read. The slow path stats, then reads, then re-stats; the
    // injected rewrite changes mtime between the two stats and the
    // verification refuses to bless the post-rewrite content as runner-owned.
    await controller.releaseForPrompt();
    await fs.appendFile(
      sessionFile,
      '{"type":"message","id":"a1","parentId":null,"timestamp":"2026-05-19T00:00:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"x"}]}}\n',
      "utf8",
    );

    const sizeBeforeRace = (await fs.stat(sessionFile)).size;
    const rewritten = Buffer.alloc(sizeBeforeRace, 0x79);
    const readFileSpy = vi.spyOn(fs, "readFile");
    readFileSpy.mockImplementationOnce(async (target) => {
      readFileSpy.mockRestore();
      await fs.writeFile(target as string, rewritten);
      return fs.readFile(target as string);
    });

    try {
      await expect(controller.withSessionWriteLock(() => "late-write")).rejects.toBeInstanceOf(
        EmbeddedAttemptSessionTakeoverError,
      );
      expect(controller.hasSessionTakeover()).toBe(true);
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("rejects post-prompt writes when the session file is rewritten in place", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    // Concurrent compaction or another owner rewriting the transcript in place
    // would change the file's stat without an append-only growth. The fence
    // must still trip even though no user-role entry was added.
    await fs.writeFile(sessionFile, '{"type":"session","compacted":true}\n', "utf8");

    await expect(controller.withSessionWriteLock(() => "late-write")).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
  });

  it("rejects post-prompt writes when the session file is replaced", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const acquireSessionWriteLock = vi.fn(async () => ({ release }));
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: { ...lockOptions, sessionFile },
    });

    await controller.releaseForPrompt();
    // A different owner could atomically replace the session file (unlink +
    // recreate). dev/ino change must trip the fence regardless of content.
    await fs.rm(sessionFile);
    await fs.writeFile(
      sessionFile,
      '{"type":"session"}\n{"type":"message","id":"new-owner","message":{"role":"assistant","content":"hello"}}\n',
      "utf8",
    );

    await expect(controller.withSessionWriteLock(() => "late-write")).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
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
    const session = { agent: { streamFn } };

    installPromptSubmissionLockRelease({ session, waitForSessionEvents, releaseForPrompt });

    await session.agent.streamFn("model", "context");

    expect(waitForSessionEvents).toHaveBeenCalledWith(session);
    expect(releaseForPrompt).toHaveBeenCalledTimes(1);
    expect(streamFn).toHaveBeenCalledWith("model", "context");
    expect(events).toEqual(["drain", "release", "stream"]);
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
    const session = { agent: { streamFn: firstStreamFn } };

    installPromptSubmissionLockRelease({ session, waitForSessionEvents, releaseForPrompt });
    installPromptSubmissionLockRelease({ session, waitForSessionEvents, releaseForPrompt });
    await session.agent.streamFn("first-model");

    session.agent.streamFn = secondStreamFn;
    installPromptSubmissionLockRelease({ session, waitForSessionEvents, releaseForPrompt });
    await session.agent.streamFn("second-model");

    expect(firstStreamFn).toHaveBeenCalledTimes(1);
    expect(secondStreamFn).toHaveBeenCalledTimes(1);
    expect(waitForSessionEvents).toHaveBeenCalledTimes(2);
    expect(releaseForPrompt).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      "drain",
      "release",
      "first-stream",
      "drain",
      "release",
      "second-stream",
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
});
