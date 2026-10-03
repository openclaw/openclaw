import fsSync from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueCredsSave } from "./creds-persistence.js";
import {
  cleanupSessionTest,
  createTempAuthDir,
  emitCredsUpdate,
  mockFsOpenForCredsWrites,
  resetSessionTestMocks,
} from "./session-test-helpers.js";
import { getLastSocket } from "./test-helpers.js";

let session!: typeof import("./session.js");

describe("web session credential queue", () => {
  beforeAll(async () => {
    session = await import("./session.js");
  });

  beforeEach(() => {
    resetSessionTestMocks();
  });

  afterEach(async () => {
    await cleanupSessionTest(session.waitForCredsSaveQueue);
  });

  it("does not clobber creds backup when creds.json is corrupted", async () => {
    const authDir = createTempAuthDir("openclaw-wa-corrupt-backup");
    const backupPath = path.join(authDir, "creds.json.bak");
    fsSync.writeFileSync(path.join(authDir, "creds.json"), "{", "utf-8");
    const openMock = mockFsOpenForCredsWrites();

    try {
      await session.createWaSocket(false, false, { authDir });
      await emitCredsUpdate(session.waitForCredsSaveQueue, authDir);

      expect(fsSync.existsSync(backupPath)).toBe(false);
      expect(openMock.tempHandles).toHaveLength(1);
    } finally {
      openMock.restore();
    }
  });

  it("serializes creds.update saves to avoid overlapping writes", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const authDir = createTempAuthDir("openclaw-wa-queue");
    const openMock = mockFsOpenForCredsWrites({
      onTempWrite: async (filePath) => {
        if (filePath.startsWith(authDir)) {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await gate;
          inFlight -= 1;
        }
      },
    });

    await session.createWaSocket(false, false, { authDir });
    const sock = getLastSocket();

    sock.ev.emit("creds.update", {});
    sock.ev.emit("creds.update", {});

    try {
      await vi.waitFor(() => {
        expect(inFlight).toBe(1);
      });
    } finally {
      (release as (() => void) | null)?.();
    }

    await session.waitForCredsSaveQueue(authDir);

    expect(openMock.tempHandles).toHaveLength(3);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
    openMock.restore();
  });

  it("lets different authDir queues flush independently", async () => {
    let inFlightA = 0;
    let inFlightB = 0;
    let releaseA: (() => void) | null = null;
    let releaseB: (() => void) | null = null;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    const authDirA = createTempAuthDir("openclaw-wa-a");
    const authDirB = createTempAuthDir("openclaw-wa-b");
    const onError = vi.fn();

    enqueueCredsSave(
      authDirA,
      async () => {
        inFlightA += 1;
        await gateA;
        inFlightA -= 1;
      },
      onError,
    );
    enqueueCredsSave(
      authDirB,
      async () => {
        inFlightB += 1;
        await gateB;
        inFlightB -= 1;
      },
      onError,
    );

    try {
      await vi.waitFor(() => {
        expect(inFlightA).toBe(1);
        expect(inFlightB).toBe(1);
      });
    } finally {
      (releaseA as (() => void) | null)?.();
      (releaseB as (() => void) | null)?.();
    }

    await Promise.all([
      session.waitForCredsSaveQueue(authDirA),
      session.waitForCredsSaveQueue(authDirB),
    ]);

    expect(inFlightA).toBe(0);
    expect(inFlightB).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it("rotates creds backup when creds.json is valid JSON", async () => {
    const authDir = createTempAuthDir("openclaw-wa-rotate-backup");
    const credsPath = path.join(authDir, "creds.json");
    const backupPath = path.join(authDir, "creds.json.bak");
    fsSync.writeFileSync(credsPath, "{}", "utf-8");
    const openMock = mockFsOpenForCredsWrites();

    try {
      await session.createWaSocket(false, false, { authDir });
      await emitCredsUpdate(session.waitForCredsSaveQueue, authDir);

      expect(fsSync.readFileSync(backupPath, "utf-8")).toBe("{}");
      expect(openMock.tempHandles).toHaveLength(2);
    } finally {
      openMock.restore();
    }
  });

  it.runIf(process.platform !== "win32")(
    "does not rotate creds backup through a symlinked backup path",
    async () => {
      const authDir = createTempAuthDir("openclaw-wa-rotate-backup-symlink");
      const credsPath = path.join(authDir, "creds.json");
      const backupPath = path.join(authDir, "creds.json.bak");
      const targetPath = path.join(authDir, "backup-target.json");
      fsSync.writeFileSync(credsPath, "{}", "utf-8");
      fsSync.writeFileSync(targetPath, "keep", "utf-8");
      fsSync.symlinkSync(targetPath, backupPath);

      await session.createWaSocket(false, false, { authDir });
      await emitCredsUpdate(session.waitForCredsSaveQueue, authDir);

      expect(fsSync.lstatSync(backupPath).isSymbolicLink()).toBe(true);
      expect(fsSync.readFileSync(targetPath, "utf-8")).toBe("keep");
    },
  );
});
