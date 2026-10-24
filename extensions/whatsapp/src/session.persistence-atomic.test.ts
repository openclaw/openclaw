import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupSessionTest,
  createTempAuthDir,
  emitCredsUpdate,
  mockFsOpenForCredsWrites,
  requireValue,
  resetSessionTestMocks,
} from "./session-test-helpers.js";
import { baileys } from "./test-helpers.js";

const useMultiFileAuthStateMock = vi.mocked(baileys.useMultiFileAuthState);
let session!: typeof import("./session.js");

describe("web session atomic credential writes", () => {
  beforeAll(async () => {
    session = await import("./session.js");
  });

  beforeEach(() => {
    resetSessionTestMocks();
  });

  afterEach(async () => {
    await cleanupSessionTest(session.waitForCredsSaveQueue);
  });

  it("writes creds.json atomically via temp file and rename", async () => {
    const authDir = createTempAuthDir("openclaw-wa-creds-atomic-write");
    const credsPath = path.join(authDir, "creds.json");
    const openMock = mockFsOpenForCredsWrites();
    const renameSpy = vi.spyOn(fs, "rename");
    const rmSpy = vi.spyOn(fs, "rm");

    try {
      await session.writeCredsJsonAtomically(authDir, { me: { id: "123@s.whatsapp.net" } });

      const write = requireValue(openMock.writes[0], "WhatsApp credential write");
      const tempHandle = requireValue(openMock.tempHandles[0], "WhatsApp credential handle");
      expect(write.filePath).toContain(path.join(authDir, ".creds."));
      expect(typeof write.data).toBe("string");
      expect(tempHandle.mode).toBe(0o600);
      expect(tempHandle.flags).toBe("wx");
      expect(openMock.tempHandles).toHaveLength(1);
      expect(tempHandle.chmod).toHaveBeenCalledWith(0o600);
      expect(tempHandle.sync).toHaveBeenCalledTimes(1);
      expect(tempHandle.close).toHaveBeenCalledTimes(1);
      expect(renameSpy).toHaveBeenCalledExactlyOnceWith(tempHandle.filePath, credsPath);
      expect(rmSpy).not.toHaveBeenCalled();
      expect(openMock.dirHandles).toHaveLength(1);
      expect(openMock.dirHandles[0]?.sync).toHaveBeenCalledTimes(1);
      expect(openMock.dirHandles[0]?.close).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fsSync.readFileSync(credsPath, "utf8"))).toEqual({
        me: { id: "123@s.whatsapp.net" },
      });
      expect(fsSync.statSync(credsPath).mode & 0o777).toBe(0o600);
      if (process.platform !== "win32") {
        const parentHandle = requireValue(
          openMock.handles.find(
            ({ filePath, flags }) => filePath === authDir && typeof flags === "number",
          ),
          "pinned WhatsApp credential directory",
        );
        expect(parentHandle.flags).toBe(
          fsSync.constants.O_RDONLY |
            fsSync.constants.O_DIRECTORY |
            fsSync.constants.O_NOFOLLOW |
            fsSync.constants.O_NONBLOCK,
        );
        // fs-safe 0.8.0 skips the directory chmod when the dir already has the
        // target mode; the fixture starts at 0o700, so no chmod is dispatched.
        expect(parentHandle.chmod).not.toHaveBeenCalled();
        expect(parentHandle.close).toHaveBeenCalledTimes(1);
        expect(fsSync.statSync(authDir).mode & 0o777).toBe(0o700);
      }
    } finally {
      openMock.restore();
      renameSpy.mockRestore();
      rmSpy.mockRestore();
    }
  });

  it("keeps the previous creds.json valid if the atomic rename fails", async () => {
    const authDir = createTempAuthDir("openclaw-wa-creds-atomic");
    const credsPath = path.join(authDir, "creds.json");
    const originalCreds = { me: { id: "old@s.whatsapp.net" } };
    const nextCreds = { me: { id: "new@s.whatsapp.net" } };
    fsSync.writeFileSync(credsPath, JSON.stringify(originalCreds), "utf-8");
    const rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (
        typeof from === "string" &&
        typeof to === "string" &&
        from.startsWith(path.join(authDir, ".creds.")) &&
        to === credsPath
      ) {
        throw new Error("simulated atomic rename failure");
      }
      return rename(from, to);
    });

    useMultiFileAuthStateMock.mockResolvedValueOnce({
      state: {
        creds: nextCreds as never,
        keys: {} as never,
      },
      saveCreds: vi.fn(),
    });

    await session.createWaSocket(false, false, { authDir });
    await emitCredsUpdate(session.waitForCredsSaveQueue, authDir);

    const raw = fsSync.readFileSync(credsPath, "utf-8");
    const tempEntries = fsSync
      .readdirSync(authDir)
      .filter((entry) => entry.startsWith(".creds.") && entry.endsWith(".tmp"));

    const primaryRenameCalls = renameSpy.mock.calls.filter(
      ([from, to]) =>
        typeof from === "string" &&
        typeof to === "string" &&
        from.startsWith(path.join(authDir, ".creds.")) &&
        to === credsPath,
    );
    expect(primaryRenameCalls).toHaveLength(1);
    const parsedCreds = JSON.parse(raw) as unknown;
    expect(parsedCreds).toEqual(originalCreds);
    expect(tempEntries).toHaveLength(0);

    renameSpy.mockRestore();
  });
});
