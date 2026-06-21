// Codex tests cover attempt client cleanup plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  interruptCodexTurnBestEffort,
  runCodexTurnStartWithLease,
  settleCodexAppServerClientLease,
  unsubscribeCodexThreadBestEffort,
  validateCodexThreadCreationResponse,
} from "./attempt-client-cleanup.js";
import { CodexAppServerRpcError } from "./client.js";

describe("Codex app-server attempt client cleanup", () => {
  it("keeps the client lease after a structured turn-start rejection", async () => {
    const abandon = vi.fn(async () => undefined);
    const error = new CodexAppServerRpcError({ message: "turn rejected" }, "turn/start");

    await expect(
      runCodexTurnStartWithLease({ abandon } as never, async () => {
        throw error;
      }),
    ).rejects.toBe(error);

    expect(abandon).not.toHaveBeenCalled();
  });

  it("abandons only the exact client lease after an ambiguous turn-start timeout", async () => {
    const abandon = vi.fn(async () => undefined);
    const otherAbandon = vi.fn(async () => undefined);

    await expect(
      runCodexTurnStartWithLease({ abandon } as never, async () => {
        throw new Error("turn/start timed out");
      }),
    ).rejects.toThrow("turn/start timed out");

    expect(abandon).toHaveBeenCalledTimes(1);
    expect(otherAbandon).not.toHaveBeenCalled();
  });

  it("interrupts turns with optional request timeout", () => {
    const request = vi.fn(async () => ({}));

    interruptCodexTurnBestEffort({ request } as never, {
      threadId: "thread-1",
      turnId: "turn-1",
      timeoutMs: 123,
    });

    expect(request).toHaveBeenCalledWith(
      "turn/interrupt",
      { threadId: "thread-1", turnId: "turn-1" },
      { timeoutMs: 123 },
    );
  });

  it("unsubscribes a retained thread when its create response is malformed", async () => {
    const request = vi.fn(async () => ({}));
    const abandon = vi.fn(async () => undefined);
    const invalidResponse = { thread: { id: "thread-1" } };

    await expect(
      validateCodexThreadCreationResponse(
        { client: { request } as never, abandon },
        invalidResponse,
        () => {
          throw new Error("invalid thread/start response");
        },
      ),
    ).rejects.toThrow("invalid thread/start response");

    expect(request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "thread-1" },
      { timeoutMs: 5_000 },
    );
    expect(abandon).not.toHaveBeenCalled();
  });

  it.each([
    ["omits the retained thread id", {}, vi.fn(async () => ({}))],
    [
      "cannot confirm unsubscribe",
      { thread: { id: "thread-1" } },
      vi.fn(async () => {
        throw new Error("connection lost");
      }),
    ],
  ])(
    "retires the client when a malformed create response %s",
    async (_label, response, request) => {
      const abandon = vi.fn(async () => undefined);

      await expect(
        validateCodexThreadCreationResponse(
          { client: { request } as never, abandon },
          response,
          () => {
            throw new Error("invalid thread/start response");
          },
        ),
      ).rejects.toThrow("subscription could not be released");

      expect(abandon).toHaveBeenCalledOnce();
    },
  );

  it("reports unsubscribe cleanup failures", async () => {
    const request = vi.fn(async () => {
      throw new Error("already gone");
    });

    await expect(
      unsubscribeCodexThreadBestEffort({ request } as never, {
        threadId: "thread-1",
        timeoutMs: 123,
      }),
    ).resolves.toBe(false);

    expect(request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "thread-1" },
      { timeoutMs: 123 },
    );
  });

  it("returns leases only after thread cleanup is confirmed", async () => {
    const release = vi.fn();
    const abandon = vi.fn(async () => undefined);
    await settleCodexAppServerClientLease(
      { client: { request: vi.fn(async () => ({})) }, release, abandon } as never,
      { threadId: "thread-ok", timeoutMs: 123 },
    );
    expect(release).toHaveBeenCalledOnce();
    expect(abandon).not.toHaveBeenCalled();

    release.mockClear();
    await settleCodexAppServerClientLease(
      {
        client: {
          request: vi.fn(async () => {
            throw new Error("unsubscribe failed");
          }),
        },
        release,
        abandon,
      } as never,
      { threadId: "thread-stale", timeoutMs: 123 },
    );
    expect(release).not.toHaveBeenCalled();
    expect(abandon).toHaveBeenCalledOnce();
  });
});
