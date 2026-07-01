// Sandbox scope lock tests cover cross-process lock acquisition for deterministic runtime paths.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const scopeLockMocks = vi.hoisted(() => {
  const nodePath = require("node:path") as typeof import("node:path");
  const testStateDir = nodePath.join("/tmp", "openclaw-sandbox-scope-lock-test");
  const lockCalls: Array<{
    sessionFile: string;
    timeoutMs?: number;
    staleMs?: number;
    maxHoldMs?: number;
    allowReentrant?: boolean;
  }> = [];
  const releases: string[] = [];
  const acquireSessionWriteLock = vi.fn(
    async (params: {
      sessionFile: string;
      timeoutMs?: number;
      staleMs?: number;
      maxHoldMs?: number;
      allowReentrant?: boolean;
    }) => {
      lockCalls.push(params);
      return {
        release: vi.fn(async () => {
          releases.push(params.sessionFile);
        }),
      };
    },
  );
  return { acquireSessionWriteLock, lockCalls, releases, testStateDir };
});

vi.mock("../session-write-lock.js", () => ({
  acquireSessionWriteLock: scopeLockMocks.acquireSessionWriteLock,
}));

vi.mock("./constants.js", () => ({
  SANDBOX_STATE_DIR: scopeLockMocks.testStateDir,
}));

import { hashTextSha256 } from "./hash.js";
import { withSandboxScopeLocks } from "./scope-lock.js";

function lockFileForScope(scopeKey: string): string {
  return path.join(
    scopeLockMocks.testStateDir,
    "locks",
    "scope",
    `scope-${hashTextSha256(scopeKey)}.jsonl`,
  );
}

afterEach(() => {
  scopeLockMocks.acquireSessionWriteLock.mockClear();
  scopeLockMocks.lockCalls.length = 0;
  scopeLockMocks.releases.length = 0;
});

describe("withSandboxScopeLocks", () => {
  it("acquires durable locks once per sorted scope", async () => {
    const ran: string[] = [];

    await withSandboxScopeLocks(["scope-b", "scope-a", "scope-a"], async () => {
      ran.push("callback");
    });

    const scopeAFilename = lockFileForScope("scope-a");
    const scopeBFilename = lockFileForScope("scope-b");
    expect(ran).toEqual(["callback"]);
    expect(scopeLockMocks.lockCalls).toEqual([
      expect.objectContaining({
        sessionFile: scopeAFilename,
        timeoutMs: Number.POSITIVE_INFINITY,
        staleMs: 60 * 60 * 1000,
        maxHoldMs: 30 * 60 * 1000,
        allowReentrant: true,
      }),
      expect.objectContaining({
        sessionFile: scopeBFilename,
        timeoutMs: Number.POSITIVE_INFINITY,
        staleMs: 60 * 60 * 1000,
        maxHoldMs: 30 * 60 * 1000,
        allowReentrant: true,
      }),
    ]);
    expect(scopeLockMocks.releases).toEqual([scopeBFilename, scopeAFilename]);
  });

  it("does not poison the process queue when durable lock acquisition fails", async () => {
    scopeLockMocks.acquireSessionWriteLock.mockRejectedValueOnce(new Error("scope lock busy"));

    await expect(withSandboxScopeLocks(["scope-a"], async () => undefined)).rejects.toThrow(
      "scope lock busy",
    );
    await withSandboxScopeLocks(["scope-a"], async () => undefined);

    expect(scopeLockMocks.acquireSessionWriteLock).toHaveBeenCalledTimes(2);
    expect(scopeLockMocks.releases).toEqual([lockFileForScope("scope-a")]);
  });

  it("does not poison the process queue when durable lock release fails", async () => {
    scopeLockMocks.acquireSessionWriteLock.mockResolvedValueOnce({
      release: vi.fn(async () => {
        throw new Error("scope release failed");
      }),
    });

    await expect(withSandboxScopeLocks(["scope-a"], async () => undefined)).rejects.toThrow(
      "scope release failed",
    );
    await withSandboxScopeLocks(["scope-a"], async () => undefined);

    expect(scopeLockMocks.acquireSessionWriteLock).toHaveBeenCalledTimes(2);
    expect(scopeLockMocks.releases).toEqual([lockFileForScope("scope-a")]);
  });
});
