import { describe, expect, it, vi } from "vitest";
import { releaseCompactionSessionLock } from "./compaction-session-delivery-recovery.js";

describe("compaction session delivery recovery", () => {
  it("releases the session lock before redriving suspended completions", async () => {
    const events: string[] = [];

    await releaseCompactionSessionLock({
      release: vi.fn(async () => {
        events.push("released");
      }),
      requesterSessionKey: "agent:main:main",
      redrive: vi.fn(async (requesterSessionKey) => {
        events.push(`redrive:${requesterSessionKey}`);
      }),
      onRedriveError: vi.fn(),
    });

    expect(events).toEqual(["released", "redrive:agent:main:main"]);
  });

  it("reports redrive failures without turning lock release into a failure", async () => {
    const error = new Error("redrive failed");
    const onRedriveError = vi.fn();

    await expect(
      releaseCompactionSessionLock({
        release: vi.fn(async () => undefined),
        requesterSessionKey: "agent:main:main",
        redrive: vi.fn(async () => {
          throw error;
        }),
        onRedriveError,
      }),
    ).resolves.toBeUndefined();
    expect(onRedriveError).toHaveBeenCalledWith(error);
  });

  it("only releases the lock when compaction has no requester session key", async () => {
    const redrive = vi.fn();

    await releaseCompactionSessionLock({
      release: vi.fn(async () => undefined),
      redrive,
      onRedriveError: vi.fn(),
    });

    expect(redrive).not.toHaveBeenCalled();
  });
});
