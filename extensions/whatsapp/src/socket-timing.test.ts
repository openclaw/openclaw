// Whatsapp tests cover socket timing plugin behavior.
import type { AnyMessageContent, WAMessage } from "baileys";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WHATSAPP_SOCKET_TIMING,
  createWhatsAppSocketOperationTimeoutAdapter,
  isWhatsAppSocketOperationTimeoutError,
  resolveWhatsAppSocketOperationTimeoutMs,
  resolveWhatsAppSocketTiming,
  withWhatsAppSocketOperationTimeout,
} from "./socket-timing.js";

const effectGate = vi.hoisted(() => ({ prepare: undefined as (() => Promise<void>) | undefined }));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>();
  return {
    ...actual,
    captureEffectAuthority: () => {
      const authority = actual.captureEffectAuthority();
      const prepare = effectGate.prepare;
      return prepare
        ? {
            ...authority,
            initiate: async <T>(effect: () => T | Promise<T>) => {
              await prepare();
              return authority.initiate(effect);
            },
          }
        : authority;
    },
  };
});

afterEach(() => {
  effectGate.prepare = undefined;
});

describe("resolveWhatsAppSocketTiming", () => {
  it("uses OpenClaw's explicit WhatsApp Web socket defaults", () => {
    expect(resolveWhatsAppSocketTiming()).toEqual(DEFAULT_WHATSAPP_SOCKET_TIMING);
  });

  it("lets call-site overrides take precedence over defaults", () => {
    expect(
      resolveWhatsAppSocketTiming({
        keepAliveIntervalMs: 20_000,
      }),
    ).toEqual({
      keepAliveIntervalMs: 20_000,
      connectTimeoutMs: DEFAULT_WHATSAPP_SOCKET_TIMING.connectTimeoutMs,
      defaultQueryTimeoutMs: DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
    });
  });

  it("rejects invalid numeric timing values", () => {
    expect(
      resolveWhatsAppSocketTiming({
        keepAliveIntervalMs: -1,
        connectTimeoutMs: Number.POSITIVE_INFINITY,
        defaultQueryTimeoutMs: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toEqual(DEFAULT_WHATSAPP_SOCKET_TIMING);
  });

  it("clamps oversized operation timeouts before scheduling timers", async () => {
    expect(resolveWhatsAppSocketOperationTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });
});

describe("withWhatsAppSocketOperationTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds a stalled readMessages socket operation with a typed timeout", async () => {
    vi.useFakeTimers();
    // A WhatsApp read-receipt call that never resolves (socket stall).
    const stalled = new Promise<void>(() => {});
    const bounded = withWhatsAppSocketOperationTimeout(
      "readMessages",
      stalled,
      DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
    );
    const failurePromise = bounded.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs);
    const failure = await failurePromise;
    expect(failure).toMatchObject({
      name: "WhatsAppSocketOperationTimeoutError",
      operation: "readMessages",
      timeoutMs: DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
      deliveryState: "unknown",
    });
    expect(isWhatsAppSocketOperationTimeoutError(failure)).toBe(true);
    // The bounding timer is cleared once the operation settles.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves the operation value when it settles before the bound", async () => {
    vi.useFakeTimers();
    const bounded = withWhatsAppSocketOperationTimeout(
      "readMessages",
      Promise.resolve("read"),
      DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
    );
    await expect(bounded).resolves.toBe("read");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("createWhatsAppSocketOperationTimeoutAdapter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["message", "presence"] as const)(
    "rechecks the selected socket after %s authority preparation",
    async (operation) => {
      const preparing = Promise.withResolvers<void>();
      const prepared = Promise.withResolvers<void>();
      const revoked = new Error("socket replaced");
      let current = true;
      effectGate.prepare = async () => {
        preparing.resolve();
        await prepared.promise;
      };
      const sock = {
        sendMessage: vi.fn(async () => undefined),
        sendPresenceUpdate: vi.fn(async () => undefined),
      };
      const adapter = createWhatsAppSocketOperationTimeoutAdapter(sock, 30_000, {
        assertCurrent: () => {
          if (!current) {
            throw revoked;
          }
        },
      });
      const send = (
        operation === "message"
          ? adapter.sendMessage("111@s.whatsapp.net", { text: "hello" })
          : adapter.sendPresenceUpdate("composing", "111@s.whatsapp.net")
      ).catch((error: unknown) => error);
      await Promise.race([
        preparing.promise,
        send.then(() => {
          throw new Error("Socket handoff bypassed authority preparation");
        }),
      ]);
      expect(sock.sendMessage).not.toHaveBeenCalled();
      expect(sock.sendPresenceUpdate).not.toHaveBeenCalled();
      current = false;
      prepared.resolve();
      expect(await send).toBe(revoked);
      expect(sock.sendMessage).not.toHaveBeenCalled();
      expect(sock.sendPresenceUpdate).not.toHaveBeenCalled();
    },
  );

  it("does not initiate a send whose timeout expired during authority preparation", async () => {
    vi.useFakeTimers();
    const preparing = Promise.withResolvers<void>();
    const prepared = Promise.withResolvers<void>();
    effectGate.prepare = async () => {
      preparing.resolve();
      await prepared.promise;
    };
    const sock = {
      sendMessage: vi.fn(async () => undefined),
      sendPresenceUpdate: vi.fn(async () => undefined),
    };
    let retained: Promise<WAMessage | undefined> | undefined;
    const adapter = createWhatsAppSocketOperationTimeoutAdapter(sock, 1_000, {
      onSendMessageTimeout: ({ promise }) => {
        retained = promise;
      },
    });
    const send = adapter.sendMessage("111@s.whatsapp.net", { text: "late" });
    const rejected = expect(send).rejects.toMatchObject({
      name: "WhatsAppSocketOperationTimeoutError",
    });
    await Promise.race([
      preparing.promise,
      send.then(() => {
        throw new Error("Socket handoff bypassed authority preparation");
      }),
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    const settled = expect(retained).rejects.toMatchObject({
      name: "WhatsAppSocketOperationTimeoutError",
    });
    prepared.resolve();
    await settled;
    expect(sock.sendMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains each queued send's authority instead of borrowing the active sender", async () => {
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<WAMessage | undefined>();
    const sock = {
      sendMessage: vi.fn(() => {
        started.resolve();
        return response.promise;
      }),
      sendPresenceUpdate: vi.fn(async () => undefined),
    };
    const adapter = createWhatsAppSocketOperationTimeoutAdapter(sock, 30_000);
    const first = adapter.sendMessage("111@s.whatsapp.net", { text: "first" });
    await started.promise;
    const refusal = new Error("queued sender retired");
    effectGate.prepare = async () => {
      throw refusal;
    };
    const second = adapter
      .sendMessage("222@s.whatsapp.net", { text: "second" })
      .catch((error: unknown) => error);
    effectGate.prepare = undefined;
    response.resolve(undefined);
    await first;
    expect(await second).toBe(refusal);
    expect(sock.sendMessage).toHaveBeenCalledOnce();
  });

  it("serializes sendMessage calls across adapter instances for the same socket", async () => {
    const started: string[] = [];
    const resolves: Array<(value: WAMessage) => void> = [];
    const sock = {
      sendMessage: vi.fn(
        async (jid: string, content: AnyMessageContent): Promise<WAMessage | undefined> =>
          await new Promise((resolve) => {
            const text =
              typeof content === "object" && content && "text" in content ? content.text : "";
            started.push(`${jid}:${text}`);
            resolves.push(resolve);
          }),
      ),
      sendPresenceUpdate: vi.fn(async () => undefined),
    };

    const first = createWhatsAppSocketOperationTimeoutAdapter(sock, 30_000).sendMessage(
      "111@s.whatsapp.net",
      { text: "first" },
    );
    await vi.waitFor(() => expect(started).toEqual(["111@s.whatsapp.net:first"]));

    const second = createWhatsAppSocketOperationTimeoutAdapter(sock, 30_000).sendMessage(
      "222@s.whatsapp.net",
      { text: "second" },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["111@s.whatsapp.net:first"]);

    resolves[0]?.({ key: { id: "msg-1" } } as WAMessage);
    await expect(first).resolves.toMatchObject({ key: { id: "msg-1" } });
    await vi.waitFor(() =>
      expect(started).toEqual(["111@s.whatsapp.net:first", "222@s.whatsapp.net:second"]),
    );

    resolves[1]?.({ key: { id: "msg-2" } } as WAMessage);
    await expect(second).resolves.toMatchObject({ key: { id: "msg-2" } });
  });

  it("releases the send queue after a socket operation timeout", async () => {
    vi.useFakeTimers();
    const started = Promise.withResolvers<void>();
    const sendMessage = vi
      .fn<(jid: string, content: AnyMessageContent) => Promise<WAMessage | undefined>>()
      .mockImplementationOnce(async () => {
        started.resolve();
        return await new Promise(() => {});
      })
      .mockResolvedValueOnce({ key: { id: "msg-2" } } as WAMessage);
    const sock = {
      sendMessage,
      sendPresenceUpdate: vi.fn(async () => undefined),
    };

    const first = createWhatsAppSocketOperationTimeoutAdapter(sock, 1_000).sendMessage(
      "111@s.whatsapp.net",
      { text: "first" },
    );
    const firstRejection = expect(first).rejects.toMatchObject({
      name: "WhatsAppSocketOperationTimeoutError",
      operation: "sendMessage",
    });
    await started.promise;
    expect(sendMessage).toHaveBeenCalledTimes(1);

    const second = createWhatsAppSocketOperationTimeoutAdapter(sock, 1_000).sendMessage(
      "222@s.whatsapp.net",
      { text: "second" },
    );
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await firstRejection;
    await expect(second).resolves.toMatchObject({ key: { id: "msg-2" } });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
