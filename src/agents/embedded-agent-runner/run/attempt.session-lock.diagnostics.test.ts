// Coverage for the opt-in session-fence takeover diagnostics. A takeover throws
// EmbeddedAttemptSessionTakeoverError with only the file path; these diagnostics
// add, behind `session-lock` debug logging, the reason + fingerprints needed to
// tell a benign concurrent writer from a real external editor.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { debugMock, isEnabledMock } = vi.hoisted(() => ({
  debugMock: vi.fn(),
  isEnabledMock: vi.fn(() => true),
}));

vi.mock("../../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../logging/subsystem.js")>();
  const logger = {
    subsystem: "session-lock",
    isEnabled: isEnabledMock,
    trace: vi.fn(),
    debug: debugMock,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
  };
  return { ...actual, createSubsystemLogger: vi.fn(() => logger) };
});

const {
  createEmbeddedAttemptSessionLockController,
  EmbeddedAttemptSessionTakeoverError,
  resetEmbeddedAttemptSessionFileOwnersForTest,
} = await import("./attempt.session-lock.js");

const lockOptions = {
  sessionFile: "/tmp/session.jsonl",
  timeoutMs: 60_000,
  staleMs: 1_800_000,
  maxHoldMs: 300_000,
};

const tempDirs: string[] = [];

afterEach(async () => {
  debugMock.mockClear();
  isEnabledMock.mockReturnValue(true);
  resetEmbeddedAttemptSessionFileOwnersForTest();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function createTempSessionFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-lock-diagnostics-"));
  tempDirs.push(dir);
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(sessionFile, '{"type":"session"}\n', "utf8");
  return sessionFile;
}

async function triggerExternalTakeover(): Promise<{ sessionFile: string; error: unknown }> {
  const sessionFile = await createTempSessionFile();
  const release = vi.fn(async () => {});
  const controller = await createEmbeddedAttemptSessionLockController({
    acquireSessionWriteLock: vi.fn(async () => ({ release })),
    lockOptions: { ...lockOptions, sessionFile },
  });
  await controller.releaseForPrompt();
  // A different process appends to the session file while the prompt lock is released.
  await fs.appendFile(sessionFile, '{"type":"message","id":"external-takeover"}\n', "utf8");
  let error: unknown;
  try {
    await controller.withSessionWriteLock(() => "late-write");
  } catch (caught) {
    error = caught;
  }
  await controller.acquireForCleanup().then((lock) => lock.release());
  return { sessionFile, error };
}

describe("session-fence takeover diagnostics", () => {
  it("emits a structured diagnostic identifying the tripped check on takeover", async () => {
    const { sessionFile, error } = await triggerExternalTakeover();

    expect(error).toBeInstanceOf(EmbeddedAttemptSessionTakeoverError);
    expect(debugMock).toHaveBeenCalledTimes(1);
    const [message, meta] = debugMock.mock.calls[0] ?? [];
    expect(message).toBe("embedded session fence takeover: unexplained-session-file-change");
    expect(meta).toMatchObject({
      reason: "unexplained-session-file-change",
      sessionFile,
      fenceActive: true,
    });
    const typedMeta = meta as { currentFingerprint: unknown; expectedFingerprint: unknown };
    expect(typedMeta.currentFingerprint).toMatchObject({ exists: true, size: expect.any(String) });
    expect(typedMeta.expectedFingerprint).toMatchObject({ exists: true });
  });

  it("stays silent when session-lock debug logging is disabled (zero overhead)", async () => {
    isEnabledMock.mockReturnValue(false);
    const { error } = await triggerExternalTakeover();
    // The takeover still fires — only the diagnostic is gated.
    expect(error).toBeInstanceOf(EmbeddedAttemptSessionTakeoverError);
    expect(debugMock).not.toHaveBeenCalled();
  });

  it("does not emit a diagnostic when no takeover occurs", async () => {
    const sessionFile = await createTempSessionFile();
    const release = vi.fn(async () => {});
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release })),
      lockOptions: { ...lockOptions, sessionFile },
    });
    await controller.releaseForPrompt();
    await controller.reacquireAfterPrompt();
    await controller.dispose();
    expect(debugMock).not.toHaveBeenCalled();
  });
});
