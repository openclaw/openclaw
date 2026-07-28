// Qa Channel tests cover gateway lifecycle behavior.
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaBusState, startQaBusServer } from "../../qa-lab/bus-api.js";
import { startQaGatewayAccount } from "./gateway.js";
import { handleQaInbound } from "./inbound.js";
import type { ChannelGatewayContext } from "./runtime-api.js";
import type { ResolvedQaChannelAccount } from "./types.js";

vi.mock("./inbound.js", () => ({
  handleQaInbound: vi.fn(async () => undefined),
}));

async function startJsonServer(
  handler: (req: { url?: string | undefined }) => { statusCode?: number; body: string },
) {
  const server = createServer((req, res) => {
    const response = handler({ url: req.url });
    res.writeHead(response.statusCode ?? 200, {
      "content-type": "application/json; charset=utf-8",
    });
    res.end(response.body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server failed to bind");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function startLegacyQaBusServer(state: ReturnType<typeof createQaBusState>) {
  let pollCount = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      pollCount += 1;
      const input = JSON.parse(body) as { accountId?: string; cursor?: number };
      const cursor = state.resolvePollCursor({
        accountId: input.accountId,
        cursor: input.cursor,
      });
      const result = state.poll({ accountId: input.accountId, cursor, timeoutMs: 0 });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(result));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("legacy QA bus failed to bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    pollCount: () => pollCount,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("qa-channel gateway", () => {
  const stops: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.mocked(handleQaInbound).mockReset().mockResolvedValue(undefined);
    await Promise.all(stops.splice(0).map((stop) => stop()));
  });

  it("lets native commands bypass the ordered inbound queue", async () => {
    const controller = new AbortController();
    const message = {
      id: "msg-1",
      accountId: "default",
      direction: "inbound" as const,
      conversation: { id: "alice", kind: "direct" as const },
      senderId: "alice",
      text: "hello",
      timestamp: Date.now(),
      reactions: [],
    };
    const server = await startJsonServer(() => ({
      body: JSON.stringify({
        cursor: 2,
        events: [
          { cursor: 1, kind: "inbound-message", accountId: "default", message },
          {
            cursor: 2,
            kind: "inbound-message",
            accountId: "default",
            message: { ...message, id: "msg-2", text: "follow-up" },
          },
          {
            cursor: 3,
            kind: "inbound-message",
            accountId: "default",
            message: {
              ...message,
              id: "msg-3",
              text: "/stop",
              nativeCommand: { name: "stop" },
            },
          },
        ],
      }),
    }));
    stops.push(() => server.stop());
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.mocked(handleQaInbound).mockImplementation(async ({ message: inbound }) => {
      if (inbound.text === "hello") {
        await firstPending;
      }
      if (inbound.text === "/stop") {
        controller.abort();
      }
    });
    const account: ResolvedQaChannelAccount = {
      accountId: "default",
      baseUrl: server.baseUrl,
      botDisplayName: "QA Bot",
      botUserId: "qa-bot",
      config: {},
      configured: true,
      enabled: true,
      pollTimeoutMs: 1,
    };

    const gateway = startQaGatewayAccount("qa-channel", "QA Channel", {
      abortSignal: controller.signal,
      account,
      cfg: {},
      setStatus: vi.fn(),
    } as unknown as ChannelGatewayContext<ResolvedQaChannelAccount>);

    await vi.waitFor(() => {
      const handled = vi.mocked(handleQaInbound).mock.calls.map(([params]) => params.message.text);
      expect(handled).toContain("hello");
      expect(handled).toContain("/stop");
      expect(handled).not.toContain("follow-up");
    });
    releaseFirst?.();
    await gateway;
    const handled = vi.mocked(handleQaInbound).mock.calls.map(([params]) => params.message.text);
    expect(handled).toHaveLength(3);
    expect(handled).toContain("/stop");
    expect(handled.indexOf("hello")).toBeLessThan(handled.indexOf("follow-up"));
  });

  it("lets a later native command bypass an in-flight message on the real QA bus", async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    stops.push(() => bus.stop());

    const first = state.addInboundMessage({
      accountId: "default",
      conversation: { id: "alice", kind: "direct" },
      senderId: "alice",
      text: "first",
    });
    let releaseFirst = () => {};
    const firstAttempt = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstCompleted = false;
    const controller = new AbortController();
    vi.mocked(handleQaInbound).mockImplementation(async ({ message }) => {
      if (message.id === first.id) {
        await firstAttempt;
        firstCompleted = true;
      }
      if (message.nativeCommand?.name === "stop") {
        controller.abort();
      }
    });

    const account: ResolvedQaChannelAccount = {
      accountId: "default",
      baseUrl: bus.baseUrl,
      botDisplayName: "QA Bot",
      botUserId: "qa-bot",
      config: {},
      configured: true,
      enabled: true,
      pollTimeoutMs: 10,
    };
    const gateway = startQaGatewayAccount("qa-channel", "QA Channel", {
      abortSignal: controller.signal,
      account,
      cfg: {},
      setStatus: vi.fn(),
    } as unknown as ChannelGatewayContext<ResolvedQaChannelAccount>);

    try {
      await vi.waitFor(() => {
        expect(handleQaInbound).toHaveBeenCalledOnce();
      });
      state.addInboundMessage({
        accountId: "default",
        conversation: { id: "alice", kind: "direct" },
        senderId: "alice",
        text: "/stop",
        nativeCommand: { name: "stop" },
      });
      await vi.waitFor(() => {
        expect(
          vi.mocked(handleQaInbound).mock.calls.map(([params]) => params.message.text),
        ).toEqual(["first", "/stop"]);
      });
      expect(firstCompleted).toBe(false);
    } finally {
      releaseFirst();
      controller.abort();
      await gateway;
    }
  });

  it("flushes the final successful message cursor before the real gateway stops", async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    stops.push(() => bus.stop());

    const first = state.addInboundMessage({
      accountId: "default",
      conversation: { id: "alice", kind: "direct" },
      senderId: "alice",
      text: "first",
    });
    const controller = new AbortController();
    vi.mocked(handleQaInbound).mockImplementation(async ({ message }) => {
      if (message.id === first.id) {
        controller.abort();
      }
    });
    const account: ResolvedQaChannelAccount = {
      accountId: "default",
      baseUrl: bus.baseUrl,
      botDisplayName: "QA Bot",
      botUserId: "qa-bot",
      config: {},
      configured: true,
      enabled: true,
      pollTimeoutMs: 10,
    };

    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      await startQaGatewayAccount("qa-channel", "QA Channel", {
        abortSignal: controller.signal,
        account,
        cfg: {},
        setStatus: vi.fn(),
      } as unknown as ChannelGatewayContext<ResolvedQaChannelAccount>);

      expect(handleQaInbound).toHaveBeenCalledOnce();
      expect(state.getAcknowledgedPollCursor("default")).toBe(1);
      expect(state.resolvePollCursor({ accountId: "default", cursor: 0 })).toBe(1);
      expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("does not acknowledge in-flight messages on a legacy QA bus", async () => {
    const state = createQaBusState();
    const bus = await startLegacyQaBusServer(state);
    stops.push(() => bus.stop());
    const first = state.addInboundMessage({
      accountId: "default",
      conversation: { id: "alice", kind: "direct" },
      senderId: "alice",
      text: "first",
    });
    const second = state.addInboundMessage({
      accountId: "default",
      conversation: { id: "alice", kind: "direct" },
      senderId: "alice",
      text: "second",
    });
    let releaseFirst = () => {};
    const firstAttempt = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let shouldFailSecond = true;
    let restarting = false;
    const recoveredMessageIds: string[] = [];
    const restartedController = new AbortController();
    vi.mocked(handleQaInbound).mockImplementation(async ({ message }) => {
      if (message.id === first.id && !restarting) {
        await firstAttempt;
      }
      if (message.id === second.id && shouldFailSecond) {
        shouldFailSecond = false;
        throw new Error("legacy inbound failed");
      }
      if (restarting) {
        recoveredMessageIds.push(message.id);
        restartedController.abort();
      }
    });
    const account: ResolvedQaChannelAccount = {
      accountId: "default",
      baseUrl: bus.baseUrl,
      botDisplayName: "QA Bot",
      botUserId: "qa-bot",
      config: {},
      configured: true,
      enabled: true,
      pollTimeoutMs: 10,
    };
    const firstGateway = startQaGatewayAccount("qa-channel", "QA Channel", {
      abortSignal: new AbortController().signal,
      account,
      cfg: {},
      setStatus: vi.fn(),
    } as unknown as ChannelGatewayContext<ResolvedQaChannelAccount>);
    await vi.waitFor(() => {
      expect(handleQaInbound).toHaveBeenCalledOnce();
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(bus.pollCount()).toBe(1);
    const gatewayFailure = expect(firstGateway).rejects.toThrow("legacy inbound failed");
    releaseFirst();
    await gatewayFailure;
    expect(state.getAcknowledgedPollCursor("default")).toBe(1);

    restarting = true;
    const restartedGateway = startQaGatewayAccount("qa-channel", "QA Channel", {
      abortSignal: restartedController.signal,
      account,
      cfg: {},
      setStatus: vi.fn(),
    } as unknown as ChannelGatewayContext<ResolvedQaChannelAccount>);
    try {
      await vi.waitFor(() => {
        expect(recoveredMessageIds).toEqual([second.id]);
      });
    } finally {
      restartedController.abort();
      await restartedGateway.catch(() => undefined);
    }
  });

  it("clears running status when polling fails", async () => {
    const server = await startJsonServer(() => ({
      statusCode: 500,
      body: JSON.stringify({ error: "qa bus unavailable" }),
    }));
    stops.push(() => server.stop());
    const account: ResolvedQaChannelAccount = {
      accountId: "default",
      baseUrl: server.baseUrl,
      botDisplayName: "QA Bot",
      botUserId: "qa-bot",
      config: {},
      configured: true,
      enabled: true,
      pollTimeoutMs: 1,
    };
    const setStatus = vi.fn();

    await expect(
      startQaGatewayAccount("qa-channel", "QA Channel", {
        abortSignal: new AbortController().signal,
        account,
        cfg: {},
        setStatus,
      } as unknown as ChannelGatewayContext<ResolvedQaChannelAccount>),
    ).rejects.toThrow("qa bus unavailable");

    expect(setStatus.mock.calls.map(([status]) => status)).toEqual([
      {
        accountId: "default",
        baseUrl: server.baseUrl,
        configured: true,
        enabled: true,
        running: true,
      },
      {
        accountId: "default",
        running: false,
      },
    ]);
  });

  it("stops the ordered inbound queue after the first dispatch failure", async () => {
    const controller = new AbortController();
    const message = {
      id: "msg-1",
      accountId: "default",
      direction: "inbound" as const,
      conversation: { id: "alice", kind: "direct" as const },
      senderId: "alice",
      text: "first",
      timestamp: Date.now(),
      reactions: [],
    };
    const server = await startJsonServer(() => ({
      body: JSON.stringify({
        cursor: 2,
        events: [
          { cursor: 1, kind: "inbound-message", accountId: "default", message },
          {
            cursor: 2,
            kind: "inbound-message",
            accountId: "default",
            message: { ...message, id: "msg-2", text: "second" },
          },
        ],
      }),
    }));
    stops.push(() => server.stop());
    vi.mocked(handleQaInbound).mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("inbound failed");
    });
    const account: ResolvedQaChannelAccount = {
      accountId: "default",
      baseUrl: server.baseUrl,
      botDisplayName: "QA Bot",
      botUserId: "qa-bot",
      config: {},
      configured: true,
      enabled: true,
      pollTimeoutMs: 1,
    };

    await expect(
      startQaGatewayAccount("qa-channel", "QA Channel", {
        abortSignal: controller.signal,
        account,
        cfg: {},
        setStatus: vi.fn(),
      } as unknown as ChannelGatewayContext<ResolvedQaChannelAccount>),
    ).rejects.toThrow("inbound failed");
    expect(handleQaInbound).toHaveBeenCalledTimes(1);
  });

  it("replays failed and undispatched inbound messages after the gateway restarts", async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    stops.push(() => bus.stop());

    let pollCount = 0;
    bus.server.on("request", (request) => {
      if (request.url === "/v1/poll") {
        pollCount += 1;
      }
    });

    const first = state.addInboundMessage({
      accountId: "default",
      conversation: { id: "alice", kind: "direct" },
      senderId: "alice",
      text: "first",
    });
    const second = state.addInboundMessage({
      accountId: "default",
      conversation: { id: "alice", kind: "direct" },
      senderId: "alice",
      text: "second",
    });

    let rejectFirst = (_error: Error) => {};
    const firstAttempt = new Promise<void>((_resolve, reject) => {
      rejectFirst = (error) => reject(error);
    });
    let shouldFailFirst = true;
    const recoveredMessageIds: string[] = [];
    const restartedController = new AbortController();
    vi.mocked(handleQaInbound).mockImplementation(async ({ message }) => {
      if (message.id === first.id && shouldFailFirst) {
        shouldFailFirst = false;
        await firstAttempt;
      }
      recoveredMessageIds.push(message.id);
      if (recoveredMessageIds.length === 2) {
        restartedController.abort();
      }
    });

    const account: ResolvedQaChannelAccount = {
      accountId: "default",
      baseUrl: bus.baseUrl,
      botDisplayName: "QA Bot",
      botUserId: "qa-bot",
      config: {},
      configured: true,
      enabled: true,
      pollTimeoutMs: 10,
    };
    const firstController = new AbortController();
    const firstGateway = startQaGatewayAccount("qa-channel", "QA Channel", {
      abortSignal: firstController.signal,
      account,
      cfg: {},
      setStatus: vi.fn(),
    } as unknown as ChannelGatewayContext<ResolvedQaChannelAccount>);

    await vi.waitFor(() => {
      expect(pollCount).toBeGreaterThanOrEqual(2);
      expect(handleQaInbound).toHaveBeenCalledOnce();
    });
    rejectFirst(new Error("inbound failed"));
    await expect(firstGateway).rejects.toThrow("inbound failed");

    const restartedGateway = startQaGatewayAccount("qa-channel", "QA Channel", {
      abortSignal: restartedController.signal,
      account,
      cfg: {},
      setStatus: vi.fn(),
    } as unknown as ChannelGatewayContext<ResolvedQaChannelAccount>);

    try {
      await vi.waitFor(() => {
        expect(recoveredMessageIds).toEqual([first.id, second.id]);
      });
    } finally {
      restartedController.abort();
      await restartedGateway.catch(() => undefined);
    }
  });

  it.each(["ordered inbound", "bypassed native command"] as const)(
    "does not replay a successful prefix after a later %s fails",
    async (failingEvent) => {
      const state = createQaBusState();
      const bus = await startQaBusServer({ state });
      stops.push(() => bus.stop());

      let pollCount = 0;
      bus.server.on("request", (request) => {
        if (request.url === "/v1/poll") {
          pollCount += 1;
        }
      });

      const first = state.addInboundMessage({
        accountId: "default",
        conversation: { id: "alice", kind: "direct" },
        senderId: "alice",
        text: "first",
      });
      const failedInbound: { message?: ReturnType<typeof state.addInboundMessage> } = {};

      let releaseFirst = () => {};
      const firstAttempt = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let rejectSecond = (_error: Error) => {};
      const secondAttempt = new Promise<void>((_resolve, reject) => {
        rejectSecond = (error) => reject(error);
      });
      let shouldFailSecond = true;
      let restarting = false;
      const recoveredMessageIds: string[] = [];
      const restartedController = new AbortController();
      vi.mocked(handleQaInbound).mockImplementation(async ({ message }) => {
        if (message.id === first.id && !restarting && failingEvent === "bypassed native command") {
          await firstAttempt;
        }
        if (message.id === failedInbound.message?.id && shouldFailSecond) {
          shouldFailSecond = false;
          await secondAttempt;
        }
        if (restarting) {
          recoveredMessageIds.push(message.id);
          restartedController.abort();
        }
      });

      const account: ResolvedQaChannelAccount = {
        accountId: "default",
        baseUrl: bus.baseUrl,
        botDisplayName: "QA Bot",
        botUserId: "qa-bot",
        config: {},
        configured: true,
        enabled: true,
        pollTimeoutMs: 10,
      };
      const firstGateway = startQaGatewayAccount("qa-channel", "QA Channel", {
        abortSignal: new AbortController().signal,
        account,
        cfg: {},
        setStatus: vi.fn(),
      } as unknown as ChannelGatewayContext<ResolvedQaChannelAccount>);

      await vi.waitFor(() => {
        expect(vi.mocked(handleQaInbound).mock.calls.map(([params]) => params.message.id)).toEqual([
          first.id,
        ]);
      });
      const failedMessage = state.addInboundMessage({
        accountId: "default",
        conversation: { id: "alice", kind: "direct" },
        senderId: "alice",
        text: failingEvent === "bypassed native command" ? "/stop" : "second",
        ...(failingEvent === "bypassed native command" ? { nativeCommand: { name: "stop" } } : {}),
      });
      failedInbound.message = failedMessage;

      await vi.waitFor(() => {
        expect(pollCount).toBeGreaterThanOrEqual(2);
        expect(vi.mocked(handleQaInbound).mock.calls.map(([params]) => params.message.id)).toEqual([
          first.id,
          failedMessage.id,
        ]);
      });
      const gatewayFailure = expect(firstGateway).rejects.toThrow("later inbound failed");
      rejectSecond(new Error("later inbound failed"));
      releaseFirst();
      await gatewayFailure;

      restarting = true;
      const restartedGateway = startQaGatewayAccount("qa-channel", "QA Channel", {
        abortSignal: restartedController.signal,
        account,
        cfg: {},
        setStatus: vi.fn(),
      } as unknown as ChannelGatewayContext<ResolvedQaChannelAccount>);
      try {
        await vi.waitFor(() => {
          expect(recoveredMessageIds).toEqual([failedMessage.id]);
        });
        expect(state.getAcknowledgedPollCursor("default")).toBeGreaterThanOrEqual(1);
      } finally {
        restartedController.abort();
        await restartedGateway.catch(() => undefined);
      }
    },
  );
});
