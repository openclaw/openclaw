import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionWriteLockTimeoutError } from "../../session-write-lock-error.js";
import {
  acquireSessionWriteLock,
  resetSessionWriteLockStateForTest,
} from "../../session-write-lock.js";
import { createEmbeddedAttemptSessionLockController } from "./attempt.session-lock.js";

const tempDirs: string[] = [];

afterEach(async () => {
  resetSessionWriteLockStateForTest();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeSessionFile(): Promise<{ sessionFile: string; lockPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-84193-integration-"));
  tempDirs.push(dir);
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(sessionFile, '{"type":"session"}\n', "utf8");
  return { sessionFile, lockPath: `${sessionFile}.lock` };
}

describe("#84193 — real-fs proof: stuck post-run compaction releases JSONL write lock on cleanup", () => {
  it(
    "pre-cleanup: a stuck withSessionWriteLock holds the on-disk .jsonl.lock and a competing acquire times out; " +
      "post-cleanup: the same competing acquire succeeds and the diagnostic log records the abandoned owner",
    async () => {
      const { sessionFile, lockPath } = await makeSessionFile();
      const diagnostics: string[] = [];

      const controller = await createEmbeddedAttemptSessionLockController({
        acquireSessionWriteLock,
        lockOptions: {
          sessionFile,
          timeoutMs: 2_000,
          staleMs: 1_800_000,
          maxHoldMs: 300_000,
        },
        logAbandonDiagnostic: (message) => diagnostics.push(message),
      });

      await controller.releaseForPrompt();

      let unblockStuck: (() => void) | undefined;
      const stuckPromise = controller
        .withSessionWriteLock(
          () =>
            new Promise<void>((resolve) => {
              unblockStuck = resolve;
            }),
        )
        .catch(() => undefined);

      for (let i = 0; i < 40; i += 1) {
        if (unblockStuck) {
          break;
        }
        await new Promise((r) => setImmediate(r));
      }
      expect(typeof unblockStuck).toBe("function");

      // Real-fs evidence #1: lock file exists on disk with this process as owner.
      const ownerPayloadRaw = await fs.readFile(lockPath, "utf8");
      const ownerPayload = JSON.parse(ownerPayloadRaw) as { pid?: number };
      expect(ownerPayload.pid).toBe(process.pid);

      // Real-fs evidence #2: a competing acquire from a separate caller hits
      // the on-disk .jsonl.lock and times out — matching the user-reported
      // 60s SessionWriteLockTimeoutError on later Discord turns.
      const competingBefore = acquireSessionWriteLock({
        sessionFile,
        timeoutMs: 200,
        staleMs: 1_800_000,
        maxHoldMs: 60_000,
      });
      await expect(competingBefore).rejects.toBeInstanceOf(SessionWriteLockTimeoutError);

      // Trigger the fix: attempt cleanup abandons the still-held in-flight lock.
      const cleanupLock = await controller.acquireForCleanup();
      await cleanupLock.release();

      // Real-fs evidence #3: diagnostic stderr line names the abandoned owner
      // and lock target — what maintainers would see in `journalctl -u openclaw`.
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatch(/abandoned 1 in-flight lock\(s\) on attempt cleanup/);
      expect(diagnostics[0]).toContain(`sessionFile=${sessionFile}`);
      expect(diagnostics[0]).toContain(`owner=pid=${process.pid}`);

      // Real-fs evidence #4: the same competing acquire that timed out a
      // moment ago now succeeds — the next Discord turn would proceed instead
      // of bouncing off SessionWriteLockTimeoutError.
      const competingAfter = await acquireSessionWriteLock({
        sessionFile,
        timeoutMs: 5_000,
        staleMs: 1_800_000,
        maxHoldMs: 60_000,
      });
      await competingAfter.release();

      // Real-fs evidence #5: session file bytes were not torn — the
      // original transcript line is still intact, and the fence on a future
      // controller would still detect any post-abandon compaction write.
      const finalBytes = await fs.readFile(sessionFile, "utf8");
      expect(finalBytes).toBe('{"type":"session"}\n');

      unblockStuck?.();
      await stuckPromise;
    },
  );
});
