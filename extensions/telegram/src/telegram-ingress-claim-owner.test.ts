// Telegram tests cover bounded Darwin claim-owner identity lookup.
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: execFileSyncMock,
}));

async function importClaimOwnerAsDarwin() {
  vi.resetModules();
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  return await import("./telegram-ingress-claim-owner.js");
}

afterEach(() => {
  vi.restoreAllMocks();
  execFileSyncMock.mockReset();
});

describe("Telegram ingress claim owner", () => {
  it("bounds the Darwin process start-time lookup", async () => {
    execFileSyncMock.mockReturnValue("Mon Jul  6 12:34:56 2026\n");

    const { TELEGRAM_SPOOLED_UPDATE_PROCESS_ID } = await importClaimOwnerAsDarwin();

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "/bin/ps",
      ["-o", "lstart=", "-p", String(process.pid)],
      expect.objectContaining({ killSignal: "SIGKILL", timeout: 1_000 }),
    );
    expect(TELEGRAM_SPOOLED_UPDATE_PROCESS_ID.split(":")[1]).toBe(
      String(Date.UTC(2026, 6, 6, 12, 34, 56) / 1000),
    );
  });

  it("falls back to the existing x token when the Darwin lookup times out", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("spawnSync /bin/ps ETIMEDOUT"), { code: "ETIMEDOUT" });
    });

    const { TELEGRAM_SPOOLED_UPDATE_PROCESS_ID } = await importClaimOwnerAsDarwin();

    expect(TELEGRAM_SPOOLED_UPDATE_PROCESS_ID.split(":")[1]).toBe("x");
  });
});
