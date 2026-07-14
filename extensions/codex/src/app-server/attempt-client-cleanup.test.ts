// Codex tests cover attempt client cleanup plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  hardCancelCodexTurn,
  interruptAndTerminateCodexTurn,
  interruptCodexTurnBestEffort,
  retireCodexAppServerClientAfterTimedOutTurn,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";

describe("Codex app-server attempt client cleanup", () => {
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

  it("swallows unsubscribe cleanup failures", async () => {
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

  it("waits for turn completion and confirmed termination across all terminal pages", async () => {
    let resolveTurnCompletion!: (completed: boolean) => void;
    const turnCompletion = new Promise<boolean>((resolve) => {
      resolveTurnCompletion = resolve;
    });
    let resolveTermination!: (value: { terminated: boolean }) => void;
    const termination = new Promise<{ terminated: boolean }>((resolve) => {
      resolveTermination = resolve;
    });
    const request = vi.fn(
      async (method: string, params?: { cursor?: string; processId?: string }) => {
        if (method === "thread/backgroundTerminals/list") {
          if (params?.cursor === "page-2") {
            return {
              data: [
                {
                  itemId: "item-2",
                  processId: "43",
                  command: "sleep 30",
                  cwd: "/tmp",
                  osPid: null,
                  cpuPercent: null,
                  rssKb: null,
                },
              ],
              nextCursor: null,
            };
          }
          const terminated = request.mock.calls.some(
            ([calledMethod, calledParams]) =>
              calledMethod === "thread/backgroundTerminals/terminate" &&
              (calledParams as { processId?: string } | undefined)?.processId === "42",
          );
          return terminated
            ? { data: [], nextCursor: null }
            : {
                data: [
                  {
                    itemId: "item-1",
                    processId: "42",
                    command: "sleep 15",
                    cwd: "/tmp",
                    osPid: null,
                    cpuPercent: null,
                    rssKb: null,
                  },
                ],
                nextCursor: "page-2",
              };
        }
        if (method === "thread/backgroundTerminals/terminate") {
          return params?.processId === "43" ? await termination : { terminated: true };
        }
        return {};
      },
    );
    let settled = false;

    const cleanup = interruptAndTerminateCodexTurn({ request } as never, {
      threadId: "thread-1",
      turnId: "turn-1",
      timeoutMs: 1_000,
      turnCompletion,
    }).finally(() => {
      settled = true;
    });

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "turn/interrupt",
        { threadId: "thread-1", turnId: "turn-1" },
        expect.anything(),
      ),
    );
    expect(request).not.toHaveBeenCalledWith(
      "thread/backgroundTerminals/list",
      expect.anything(),
      expect.anything(),
    );
    resolveTurnCompletion(true);
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "thread/backgroundTerminals/terminate",
        { threadId: "thread-1", processId: "43" },
        expect.anything(),
      );
    });
    expect(request).toHaveBeenCalledWith(
      "thread/backgroundTerminals/list",
      { threadId: "thread-1", cursor: "page-2" },
      expect.anything(),
    );
    expect(settled).toBe(false);

    resolveTermination({ terminated: true });
    await cleanup;

    const methods = request.mock.calls.map(([method]) => method);
    expect(methods.at(0)).toBe("turn/interrupt");
    expect(methods).not.toContain("thread/backgroundTerminals/clean");
    expect(methods.indexOf("thread/backgroundTerminals/list")).toBeLessThan(
      methods.indexOf("thread/backgroundTerminals/terminate"),
    );
    expect(methods.at(-1)).toBe("thread/backgroundTerminals/list");
  });

  it("requires a stable empty terminal inventory after the completed-turn fence", async () => {
    let listCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/backgroundTerminals/list") {
        listCount += 1;
        return { data: [], nextCursor: null };
      }
      return {};
    });

    await interruptAndTerminateCodexTurn({ request } as never, {
      threadId: "thread-1",
      turnId: "turn-1",
      timeoutMs: 1_000,
      turnCompletion: Promise.resolve(true),
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "turn/interrupt",
      "thread/backgroundTerminals/list",
      "thread/backgroundTerminals/list",
    ]);
    expect(listCount).toBe(2);
  });

  it("fences the local app-server process tree after protocol cleanup", async () => {
    const request = vi.fn(async (method: string) =>
      method === "thread/backgroundTerminals/list" ? { data: [], nextCursor: null } : {},
    );
    const closeAndWait = vi.fn(async () => true);
    const client = {
      request,
      getTransportPid: () => 1234,
      closeAndWait,
    };

    await hardCancelCodexTurn(client as never, {
      threadId: "thread-1",
      turnId: "turn-1",
      timeoutMs: 1_000,
      turnCompletion: Promise.resolve(true),
    });

    expect(closeAndWait).toHaveBeenCalledWith({ processTreeTimeoutMs: 1_000 });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "turn/interrupt",
      "thread/backgroundTerminals/list",
      "thread/backgroundTerminals/list",
    ]);
  });

  it("uses a confirmed local process-tree fence when legacy protocol cleanup fails", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "thread/backgroundTerminals/list") {
        return { data: [], nextCursor: null };
      }
      if (method === "turn/interrupt") {
        throw new Error("legacy interrupt race");
      }
      return {};
    });
    const closeAndWait = vi.fn(async () => true);

    await expect(
      hardCancelCodexTurn(
        {
          request,
          getTransportPid: () => 1234,
          closeAndWait,
        } as never,
        {
          threadId: "thread-1",
          turnId: "turn-1",
          timeoutMs: 40,
          turnCompletion: Promise.resolve(false),
        },
      ),
    ).resolves.toBeUndefined();

    expect(closeAndWait).toHaveBeenCalledWith({ processTreeTimeoutMs: 40 });
  });

  it("fails closed when a listed terminal cannot be confirmed terminated", async () => {
    let inventoryCleaned = false;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/backgroundTerminals/clean") {
        inventoryCleaned = true;
        return {};
      }
      if (method === "thread/backgroundTerminals/list") {
        if (inventoryCleaned) {
          return { data: [], nextCursor: null };
        }
        return {
          data: [
            {
              itemId: "item-1",
              processId: "42",
              command: "sleep 15",
              cwd: "/tmp",
              osPid: null,
              cpuPercent: null,
              rssKb: null,
            },
          ],
          nextCursor: null,
        };
      }
      if (method === "thread/backgroundTerminals/terminate") {
        return { terminated: false };
      }
      return {};
    });

    await expect(
      interruptAndTerminateCodexTurn({ request } as never, {
        threadId: "thread-1",
        turnId: "turn-1",
        timeoutMs: 40,
        turnCompletion: Promise.resolve(true),
      }),
    ).rejects.toThrow(/could not confirm background terminal termination/i);
    expect(request).not.toHaveBeenCalledWith(
      "thread/backgroundTerminals/clean",
      expect.anything(),
      expect.anything(),
    );
  });

  it("aborts an in-flight RPC at the total cleanup deadline", async () => {
    const request = vi.fn(
      async (
        method: string,
        _params: unknown,
        options?: { signal?: AbortSignal },
      ): Promise<unknown> => {
        if (method !== "turn/interrupt") {
          return { data: [], nextCursor: null };
        }
        return await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              const reason = options.signal?.reason;
              reject(reason instanceof Error ? reason : new Error(String(reason ?? "aborted")));
            },
            { once: true },
          );
        });
      },
    );
    const startedAt = Date.now();

    await expect(
      interruptAndTerminateCodexTurn({ request } as never, {
        threadId: "thread-1",
        turnId: "turn-1",
        timeoutMs: 40,
        turnCompletion: Promise.resolve(true),
      }),
    ).rejects.toThrow(/could not confirm background terminal termination/i);

    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(request.mock.calls[0]?.[2]).toMatchObject({ signal: expect.any(AbortSignal) });
  });

  it("bounds the turn completion fence by the total abort cleanup deadline", async () => {
    const request = vi.fn(async () => ({}));
    const neverCompletes = new Promise<boolean>(() => {});

    await expect(
      Promise.race([
        interruptAndTerminateCodexTurn({ request } as never, {
          threadId: "thread-1",
          turnId: "turn-1",
          timeoutMs: 40,
          turnCompletion: neverCompletes,
        }),
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error("abort cleanup test hung")), 200);
        }),
      ]),
    ).rejects.toThrow(/turn\/completed was not observed/i);
  });

  it("closes only the isolated client after timed-out turn cleanup", async () => {
    const request = vi.fn(async () => ({}));
    const close = vi.fn();

    await retireCodexAppServerClientAfterTimedOutTurn({ request, close } as never, {
      threadId: "thread-1",
      turnId: "turn-1",
      reason: "turn_terminal_idle_timeout",
      suspectPhysicalClient: true,
    });

    expect(request).toHaveBeenCalledWith(
      "turn/interrupt",
      { threadId: "thread-1", turnId: "turn-1" },
      { timeoutMs: 5_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "thread-1" },
      { timeoutMs: 5_000 },
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
});
