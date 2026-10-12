import type { ConnectOverCDPTransport } from "playwright-core";
import { afterEach, expect, it, vi } from "vitest";
import { connectOverCdpTransport } from "../pw-session-cdp-transport.js";
import { ExtensionRelayBridge } from "./relay-bridge.js";
import { wireExtension, sendHello, replyFor } from "./relay-bridge.test-support.js";

afterEach(() => {
  vi.useRealTimers();
});

it("cleans up a timed-out Playwright handshake and reconnects across many tabs", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const bridge = new ExtensionRelayBridge();
  const tabs = Array.from({ length: 5 }, (_, index) => ({
    tabId: index + 1,
    url: `https://tab-${index + 1}.example`,
    title: `Tab ${index + 1}`,
    active: index === 0,
  }));
  let holdAttachments = true;
  let activeAttachments = 0;
  let peakAttachments = 0;
  const attachCounts = new Map<number, number>();
  const pendingReplies = new Map<number, (message: Record<string, unknown>) => void>();
  const attachWaiters = new Map<number, () => void>();
  const waitForAttachCount = (count: number) =>
    new Promise<void>((resolve) => {
      if (pendingReplies.size >= count) {
        resolve();
      } else {
        attachWaiters.set(count, resolve);
      }
    });
  const extension = wireExtension(bridge, (message) => {
    if (message.type !== "attach") {
      return replyFor(message);
    }
    activeAttachments += 1;
    peakAttachments = Math.max(peakAttachments, activeAttachments);
    attachCounts.set(message.tabId, (attachCounts.get(message.tabId) ?? 0) + 1);
    if (!holdAttachments) {
      queueMicrotask(() => {
        activeAttachments -= 1;
      });
      return replyFor(message);
    }
    pendingReplies.set(message.seq, (reply) => {
      activeAttachments -= 1;
      extension.handlers.onMessage(JSON.stringify({ ...reply, seq: message.seq }));
    });
    attachWaiters.get(pendingReplies.size)?.();
    return null;
  });
  sendHello(extension.handlers, tabs);

  type CdpClient = ReturnType<ExtensionRelayBridge["attachCdpClientSocket"]>;
  let closePromise: Promise<void> | undefined;
  const createTransport = () => {
    const clientRef: { current?: CdpClient } = {};
    const transport: ConnectOverCDPTransport = {
      send: (message) => {
        clientRef.current?.onMessage(JSON.stringify(message));
      },
      close: () => {
        closePromise = clientRef.current?.onClose();
        transport.onclose?.("synthetic CDP transport closed");
      },
    };
    clientRef.current = bridge.attachCdpClientSocket({
      send: (data) => {
        queueMicrotask(() => transport.onmessage?.(JSON.parse(data)));
      },
      close: () => {
        closePromise = clientRef.current?.onClose();
        transport.onclose?.("synthetic CDP transport closed");
      },
    });
    return transport;
  };

  try {
    const firstAttempt = connectOverCdpTransport("http://127.0.0.1:18799", {
      timeout: 5_000,
      headers: {},
      preparedTransport: createTransport(),
    });
    const timedOut = Promise.race([
      firstAttempt.then(
        () => ({ kind: "connected" as const }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      ),
      new Promise<{ kind: "stalled" }>((resolve) => {
        setTimeout(() => resolve({ kind: "stalled" }), 5_001);
      }),
    ]);
    await waitForAttachCount(2);
    const firstAttemptAttachmentCount = pendingReplies.size;
    await vi.advanceTimersByTimeAsync(5_001);
    const timeoutResult = await timedOut;
    expect(timeoutResult.kind).toBe("failed");
    if (timeoutResult.kind !== "failed") {
      throw new Error("Expected the Playwright CDP handshake to time out");
    }
    expect(String(timeoutResult.error)).toMatch(/Timeout 5000ms exceeded/u);

    // Let native work settle after Playwright closes; queued work must not start.
    const inFlight = [...pendingReplies.entries()];
    for (const [index, [seq, reply]] of inFlight.entries()) {
      const command = extension.socket.frames().find((frame) => frame.seq === seq);
      if (command?.type !== "attach" || typeof command.tabId !== "number") {
        throw new Error("Expected the held native attachment command");
      }
      reply(
        index === 0
          ? { type: "error", message: "synthetic slow attach failed" }
          : { type: "result", result: { targetId: `target-${command.tabId}` } },
      );
      pendingReplies.delete(seq);
    }
    await closePromise;
    expect(activeAttachments).toBe(0);
    expect(firstAttemptAttachmentCount).toBe(2);
    expect(peakAttachments).toBe(2);
    expect([...attachCounts.values()].reduce((sum, count) => sum + count, 0)).toBe(
      firstAttemptAttachmentCount,
    );

    holdAttachments = false;
    const recovered = await connectOverCdpTransport("http://127.0.0.1:18799", {
      timeout: 5_000,
      headers: {},
      preparedTransport: createTransport(),
    });
    expect(recovered.contexts()[0]?.pages()).toHaveLength(tabs.length);
    expect(peakAttachments).toBeLessThanOrEqual(2);
    expect([...attachCounts.values()].reduce((sum, count) => sum + count, 0)).toBe(7);
    await recovered.close();
  } finally {
    for (const frame of extension.socket.frames()) {
      if (frame.type === "attach" && typeof frame.seq === "number") {
        const reply = pendingReplies.get(frame.seq);
        const command = frame as { tabId?: unknown };
        reply?.({
          type: "result",
          result: {
            targetId: typeof command.tabId === "number" ? `cleanup-${command.tabId}` : "cleanup",
          },
        });
        pendingReplies.delete(frame.seq);
      }
    }
    bridge.dispose();
  }
});
