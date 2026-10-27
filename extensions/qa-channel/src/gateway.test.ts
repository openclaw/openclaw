import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { createStartAccountContext } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createQaBusState, startQaBusServer } from "../../qa-lab/bus-api.js";
import { startQaGatewayAccount } from "./gateway.js";
import { jsonServer as json } from "./http.test-support.js";
import { handleQaInbound } from "./inbound.js";
import type { ResolvedQaChannelAccount } from "./types.js";

vi.mock("./inbound.js", () => ({
  handleQaInbound: vi.fn(async () => undefined),
}));

function startGateway(
  baseUrl: string,
  options: {
    abortSignal?: AbortSignal;
    pollTimeoutMs?: number;
    setStatus?: ChannelGatewayContext<ResolvedQaChannelAccount>["setStatus"];
  } = {},
) {
  return startQaGatewayAccount("qa-channel", "QA Channel", {
    ...createStartAccountContext({
      account: {
        accountId: "default",
        baseUrl,
        botDisplayName: "QA Bot",
        botUserId: "qa-bot",
        config: {},
        configured: true,
        enabled: true,
        pollTimeoutMs: options.pollTimeoutMs ?? 1,
      },
      abortSignal: options.abortSignal,
    }),
    setStatus: options.setStatus ?? vi.fn(),
  });
}

function createInboundMessage(text: string, index = 0) {
  return {
    id: `msg-${index + 1}`,
    accountId: "default",
    direction: "inbound" as const,
    conversation: { id: "alice", kind: "direct" as const },
    senderId: "alice",
    text,
    timestamp: Date.now(),
    reactions: [],
    ...(text === "/stop" ? { nativeCommand: { name: "stop" } } : {}),
  };
}

describe("qa-channel gateway", () => {
  function serveMessages(...texts: string[]) {
    return json(() => ({
      body: JSON.stringify({
        cursor: texts.length,
        events: texts.map((text, index) => ({
          cursor: index + 1,
          kind: "inbound-message",
          accountId: "default",
          message: createInboundMessage(text, index),
        })),
      }),
    }));
  }
  async function busWithMessages(...texts: string[]) {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    onTestFinished(() => bus.stop());
    const messages = texts.map((text) =>
      state.addInboundMessage({
        accountId: "default",
        conversation: { id: "alice", kind: "direct" },
        senderId: "alice",
        text,
        ...(text === "/stop" ? { nativeCommand: { name: "stop" } } : {}),
      }),
    );
    return { state, bus, messages };
  }
  const handledTexts = () =>
    vi.mocked(handleQaInbound).mock.calls.map(([params]) => params.message.text);

  afterEach(() => {
    vi.mocked(handleQaInbound).mockReset().mockResolvedValue(undefined);
  });

  it("lets native commands bypass the ordered inbound queue", async () => {
    const controller = new AbortController();
    const baseUrl = await serveMessages("hello", "follow-up", "/stop");
    const { promise: firstPending, resolve: releaseFirst } = Promise.withResolvers<void>();
    vi.mocked(handleQaInbound).mockImplementation(async ({ message: inbound }) => {
      if (inbound.text === "hello") {
        await firstPending;
      }
      if (inbound.text === "/stop") {
        controller.abort();
      }
    });

    const gateway = startGateway(baseUrl, { abortSignal: controller.signal });

    await vi.waitFor(() => {
      const handled = handledTexts();
      expect(handled).toContain("hello");
      expect(handled).toContain("/stop");
      expect(handled).not.toContain("follow-up");
    });
    releaseFirst?.();
    await gateway;
    const handled = handledTexts();
    expect(handled).toHaveLength(3);
    expect(handled).toContain("/stop");
    expect(handled.indexOf("hello")).toBeLessThan(handled.indexOf("follow-up"));
  });

  it("clears running status when polling fails", async () => {
    const baseUrl = await json(() => ({
      statusCode: 500,
      body: JSON.stringify({ error: "qa bus unavailable" }),
    }));
    const setStatus = vi.fn();

    await expect(startGateway(baseUrl, { setStatus })).rejects.toThrow("qa bus unavailable");

    expect(setStatus.mock.calls.map(([status]) => status)).toEqual([
      {
        accountId: "default",
        baseUrl,
        configured: true,
        enabled: true,
        running: true,
        lifecycle: "starting",
      },
      {
        accountId: "default",
        connected: false,
        lifecycle: "recovering",
        lastError: "qa bus unavailable",
      },
      {
        accountId: "default",
        running: false,
        connected: false,
        lifecycle: "stopped",
      },
    ]);
  });

  it("publishes ready after the first successful poll", async () => {
    const controller = new AbortController();
    const baseUrl = await json(() => ({
      body: JSON.stringify({ cursor: 0, events: [] }),
    }));
    const setStatus = vi.fn();

    const run = startGateway(baseUrl, { abortSignal: controller.signal, setStatus });

    await vi.waitFor(() =>
      expect(setStatus).toHaveBeenCalledWith({
        accountId: "default",
        running: true,
        connected: true,
        lifecycle: "ready",
        lastConnectedAt: expect.any(Number),
        lastError: null,
        terminalDisconnect: undefined,
      }),
    );
    controller.abort();
    await run;
  });

  it("stops the ordered inbound queue after the first dispatch failure", async () => {
    const controller = new AbortController();
    const baseUrl = await serveMessages("first", "second");
    vi.mocked(handleQaInbound).mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("inbound failed");
    });

    await expect(startGateway(baseUrl, { abortSignal: controller.signal })).rejects.toThrow(
      "inbound failed",
    );
    expect(handleQaInbound).toHaveBeenCalledTimes(1);
  });

  it("acknowledges only the contiguous prefix when dispatches finish out of order", async () => {
    const { state, bus, messages } = await busWithMessages("first", "second", "/stop");
    let pollCount = 0;
    bus.server.on("request", (request) => {
      if (request.url === "/v1/poll") {
        pollCount += 1;
      }
    });

    const { promise: secondAttempt, reject: rejectSecond } = Promise.withResolvers<void>();
    let restarting = false;
    const recoveredMessageIds: string[] = [];
    const restartedController = new AbortController();
    vi.mocked(handleQaInbound).mockImplementation(async ({ message }) => {
      if (!restarting && message.id === messages[1]?.id) {
        await secondAttempt;
      }
      if (restarting) {
        recoveredMessageIds.push(message.id);
        if (recoveredMessageIds.length === messages.length - 1) {
          restartedController.abort();
        }
      }
    });
    const firstGateway = startGateway(bus.baseUrl, {
      abortSignal: new AbortController().signal,
      pollTimeoutMs: 10,
    });

    await vi.waitFor(() => {
      expect(pollCount).toBeGreaterThanOrEqual(2);
      expect(vi.mocked(handleQaInbound).mock.calls.map(([params]) => params.message.id)).toEqual(
        expect.arrayContaining(messages.map((message) => message.id)),
      );
    });
    rejectSecond(new Error("inbound failed"));
    await expect(firstGateway).rejects.toThrow("inbound failed");
    expect(state.getAcknowledgedPollCursor("default")).toBe(1);

    restarting = true;
    const restartedGateway = startGateway(bus.baseUrl, {
      abortSignal: restartedController.signal,
      pollTimeoutMs: 10,
    });
    try {
      await vi.waitFor(() => {
        expect(new Set(recoveredMessageIds)).toEqual(
          new Set(messages.slice(1).map((message) => message.id)),
        );
      });
    } finally {
      restartedController.abort();
      await restartedGateway.catch(() => undefined);
    }
  });

  it("records a final successful dispatch before the gateway stops", async () => {
    const { state, bus, messages } = await busWithMessages("stop after delivery");
    const controller = new AbortController();
    vi.mocked(handleQaInbound).mockImplementation(async ({ message: inbound }) => {
      if (inbound.id === messages[0]?.id) {
        controller.abort();
      }
    });

    await startGateway(bus.baseUrl, { abortSignal: controller.signal, pollTimeoutMs: 10 });

    expect(state.getAcknowledgedPollCursor("default")).toBe(1);
  });
});
