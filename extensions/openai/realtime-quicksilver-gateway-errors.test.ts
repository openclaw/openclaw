import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { delegation, turn } from "./realtime-quicksilver-events.test-support.js";
import { createGatewayHarness } from "./realtime-quicksilver-gateway.test-support.js";
import { emitSideband, FakeSocket, parseSent } from "./realtime-quicksilver.test-helpers.js";

const OPAQUE_MODEL = "gpt-live-test-canary";
const SENSITIVE_DETAILS = ["sensitive-route", "sensitive-session", "sensitive-transcript"];
const rejection = `provider rejected ${OPAQUE_MODEL} ${SENSITIVE_DETAILS.join(" ")}`;
const relayError = { message: "OpenAI GPT-Live gateway relay failed", name: "Error" };

function createDirectBridge(params: Parameters<typeof createGatewayHarness>[0] = {}) {
  const harness = createGatewayHarness({
    model: OPAQUE_MODEL,
    startSession: {},
    ...params,
  });
  onTestFinished(() => harness.bridge.close());
  return harness;
}
const eventsOf = (socket: FakeSocket, type: string) =>
  parseSent(socket).filter((event) => event.type === type);

function expectNoPrivateDetail(harness: ReturnType<typeof createDirectBridge>): void {
  const projected = JSON.stringify([
    ...harness.logger.debug.mock.calls,
    ...harness.logger.warn.mock.calls,
  ]);
  for (const privateValue of [OPAQUE_MODEL, ...SENSITIVE_DETAILS]) {
    expect(projected).not.toContain(privateValue);
  }
}

describe("GPT-Live gateway relay error projection", () => {
  it.each(["auth-store", "socket"])("redacts private %s startup failures", async (phase) => {
    const privateError = new Error(`${rejection} profile:private-account`);
    privateError.name = `Private${OPAQUE_MODEL}`;
    const socketFactory = vi.fn(() => {
      const socket = new FakeSocket("manual");
      queueMicrotask(() => {
        socket.readyState = 1;
        socket.emit("open");
        socket.emit("error", privateError);
      });
      return socket;
    });
    const harness = createDirectBridge({
      startSession: undefined,
      socketFactory,
      ...(phase === "auth-store"
        ? {
            resolveAuth: async () => {
              throw privateError;
            },
          }
        : {}),
    });
    const error = await harness.bridge.connect().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      ...relayError,
      ...(phase === "auth-store" ? { message: "OpenAI GPT-Live authentication failed" } : {}),
    });
    if (phase === "auth-store") {
      expect(socketFactory).not.toHaveBeenCalled();
    }
    expect(harness.onError).not.toHaveBeenCalled();
    expectNoPrivateDetail(harness);
  });

  it.each(["error", "close"] as const)(
    "redacts an opaque model from a live socket %s",
    async (terminalEvent) => {
      const harness = createDirectBridge();
      await harness.bridge.connect();

      if (terminalEvent === "error") {
        harness.getSocket().emit("error", new Error(rejection));
      } else {
        harness.getSocket().emit("close", 1011, Buffer.from(rejection));
      }

      expect(harness.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(relayError));
      expect(harness.onClose).toHaveBeenCalledWith("error");
      expectNoPrivateDetail(harness);
    },
  );
});

describe("OpenAI Quicksilver gateway bridge lifecycle", () => {
  it("reports recoverable provider errors to the relay while preserving its connection", async () => {
    const onError = vi.fn(),
      onTranscript = vi.fn();
    const harness = createDirectBridge({ onError, onTranscript });
    await harness.bridge.connect();
    const socket = harness.getSocket();
    emitSideband(socket, { type: "error", error: { message: "temporary voice failure" } });
    emitSideband(socket, turn("assistant", "Recovered"));
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "OpenAI GPT-Live provider error" }),
    );
    expect(onTranscript).toHaveBeenCalledWith("assistant", "Recovered", true);
    expect(harness.bridge.isConnected()).toBe(true);
  });

  it.each([
    { disposition: undefined, classified: false },
    { disposition: "detach", classified: false },
    { disposition: "detach", classified: true },
  ] as const)(
    "settles accepted delegation on close ($disposition, classified=$classified)",
    async ({ disposition, classified }) => {
      let consultSignal: AbortSignal | undefined;
      const result = createDeferred<{ text: string }>();
      onTestFinished(() => result.resolve({ text: "Finished" }));
      const runAgentConsult = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
        consultSignal = signal;
        signal?.addEventListener("abort", () => result.resolve({ text: "must not be delivered" }), {
          once: true,
        });
        return await result.promise;
      });
      const harness = createDirectBridge({
        runAgentConsult,
        handleDelegationInput: classified ? () => "consult" : undefined,
      });
      await harness.bridge.connect();
      const socket = harness.getSocket();
      emitSideband(socket, delegation("delegation-detach", "Finish after disconnect"));
      await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
      expect(eventsOf(socket, "session.context.append")).toHaveLength(classified ? 1 : 0);
      await harness.bridge.close(disposition ? { disposition } : undefined);
      const sentAtClose = socket.sent.length;
      emitSideband(socket, delegation("late", "Do not acknowledge after close"));
      expect(consultSignal?.aborted).toBe(disposition !== "detach");
      result.resolve({ text: "finished after close" });
      await nextEventLoopTurn();
      expect(eventsOf(socket, "delegation.context.append")).toEqual([]);
      expect(socket.sent).toHaveLength(sentAtClose);
      expect(runAgentConsult).toHaveBeenCalledOnce();
    },
  );
});
