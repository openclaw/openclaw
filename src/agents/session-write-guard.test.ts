import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Mock isSessionLockHeld to control lock state in tests.
const lockHeldState = { value: true };
vi.mock("./session-write-lock.js", () => ({
  isSessionLockHeld: () => lockHeldState.value,
}));

import { installSessionWriteGuard } from "./session-write-guard.js";

function createMockSessionManager() {
  const writes: string[] = [];
  const rewrites: string[] = [];
  return {
    _persist(data: string) {
      writes.push(data);
    },
    _rewriteFile(content: string) {
      rewrites.push(content);
    },
    writes,
    rewrites,
  };
}

describe("installSessionWriteGuard", () => {
  it("allows writes when lock is held", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-guard-"));
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");
    try {
      lockHeldState.value = true;
      const sm = createMockSessionManager();
      const dispose = installSessionWriteGuard({
        sessionManager: sm as never,
        sessionFile,
      });

      sm._persist("line1\n");
      expect(sm.writes).toEqual(["line1\n"]);

      sm._rewriteFile("full content");
      expect(sm.rewrites).toEqual(["full content"]);

      dispose();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects writes when lock is lost", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-guard-"));
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");
    try {
      lockHeldState.value = true;
      const sm = createMockSessionManager();
      let lockLostCalled = false;
      const dispose = installSessionWriteGuard({
        sessionManager: sm as never,
        sessionFile,
        onLockLost: () => {
          lockLostCalled = true;
        },
      });

      // Simulate lock loss.
      lockHeldState.value = false;

      expect(() => sm._persist("bad write\n")).toThrow(/write rejected/);
      expect(lockLostCalled).toBe(true);
      expect(sm.writes).toEqual([]);

      dispose();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("restores original methods on dispose", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-guard-"));
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");
    try {
      lockHeldState.value = true;
      const sm = createMockSessionManager();
      // oxlint-disable-next-line typescript/unbound-method
      const originalPersist = sm._persist;
      // oxlint-disable-next-line typescript/unbound-method
      const originalRewrite = sm._rewriteFile;

      const dispose = installSessionWriteGuard({
        sessionManager: sm as never,
        sessionFile,
      });

      // oxlint-disable-next-line typescript/unbound-method
      expect(sm._persist).not.toBe(originalPersist);
      // oxlint-disable-next-line typescript/unbound-method
      expect(sm._rewriteFile).not.toBe(originalRewrite);

      dispose();

      // oxlint-disable-next-line typescript/unbound-method
      expect(sm._persist).toBe(originalPersist);
      // oxlint-disable-next-line typescript/unbound-method
      expect(sm._rewriteFile).toBe(originalRewrite);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("allows writes after dispose even if lock is lost", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-guard-"));
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");
    try {
      lockHeldState.value = true;
      const sm = createMockSessionManager();
      const dispose = installSessionWriteGuard({
        sessionManager: sm as never,
        sessionFile,
      });

      dispose();
      lockHeldState.value = false;

      // After dispose, original methods are restored — no guard check.
      sm._persist("after dispose\n");
      expect(sm.writes).toEqual(["after dispose\n"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
