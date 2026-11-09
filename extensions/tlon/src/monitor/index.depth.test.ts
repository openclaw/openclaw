import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, expect, it, vi } from "vitest";
import {
  acquireTestPortBlock,
  type TestPortClaim,
} from "../../../../src/test-utils/port-claims.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { useTlonMonitorFixture } from "./monitor.test-harness.js";

const {
  monitorTlonProvider,
  authenticateMock,
  sleepWithAbortMock,
  inboundRuntimeMock,
  realUrbitFixture,
} = useTlonMonitorFixture();
const runningServers: Server[] = [];
const portClaims: TestPortClaim[] = [];
afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  await Promise.all(portClaims.splice(0).map((claim) => claim.release()));
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("settles synthetic SSE poison, caps group/DM rendering, and recovers without duplicate dispatch", async () => {
  const stateDir = tempDirs.make("tlon-deep-stream-");
  const controller = new AbortController();
  const ackedEventIds: number[] = [];
  const subscriptionsByApp = new Map<string, number>();
  let stream: ServerResponse | undefined;
  const streamOpened = Promise.withResolvers<ServerResponse>();
  const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;

  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

    if (req.method === "POST" && pathname === "/~/login") {
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Set-Cookie": "urbauth-~zod=proof; Path=/",
      });
      res.end("ok");
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/~/scry/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.method === "PUT" && pathname.startsWith("/~/channel/")) {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (part: string) => {
        body += part;
      });
      req.on("end", () => {
        const actions = JSON.parse(body) as Array<{
          id?: number;
          action?: string;
          app?: string;
          "event-id"?: number;
        }>;
        for (const item of actions) {
          if (item.action === "subscribe" && item.app && typeof item.id === "number") {
            subscriptionsByApp.set(item.app, item.id);
          }
          if (item.action === "ack" && typeof item["event-id"] === "number") {
            ackedEventIds.push(item["event-id"]);
          }
        }
        res.writeHead(204);
        res.end();
      });
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/~/channel/")) {
      res.writeHead(200, {
        "Cache-Control": "no-cache",
        "Content-Type": "text/event-stream",
      });
      res.write(": connected\n\n");
      streamOpened.resolve(res);
      return;
    }
    if (req.method === "DELETE" && pathname.startsWith("/~/channel/")) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const portClaim = await acquireTestPortBlock({ offsets: [0] });
  portClaims.push(portClaim);
  runningServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(portClaim.port, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const queue = createChannelIngressQueueForTests<{
    version: 1;
    receivedAt: number;
    source: "channels" | "chat";
    rawEvent: string;
  }>({
    channelId: "tlon",
    accountId: "default",
    stateDir,
  });
  realUrbitFixture.url = `http://127.0.0.1:${address.port}`;
  realUrbitFixture.enabled = true;
  realUrbitFixture.useRealIngress = true;
  realUrbitFixture.openChannelIngressQueue = () => queue;
  realUrbitFixture.config = {
    channels: {
      tlon: {
        code: "code",
        ship: "~zod",
        url: realUrbitFixture.url,
        network: { dangerouslyAllowPrivateNetwork: true },
        ownerShip: "~nec",
        groupChannels: ["chat/~zod/general"],
        dmAllowlist: ["~bus"],
      },
    },
  };
  const actualAuth = await vi.importActual<typeof import("../urbit/auth.js")>("../urbit/auth.js");
  const actualRuntimeEnv = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  authenticateMock.mockImplementation(actualAuth.authenticate);
  sleepWithAbortMock.mockImplementation(actualRuntimeEnv.sleepWithAbort);
  inboundRuntimeMock.dispatch.mockImplementation(
    async (params: { replyOptions?: { onReplyStart?: () => Promise<void> | void } }) => {
      await params.replyOptions?.onReplyStart?.();
    },
  );

  const scheduler = createTestPluginServiceScheduler();
  const monitor = monitorTlonProvider({
    scheduler,
    abortSignal: controller.signal,
    runtime,
  });

  const nativeStringify = JSON.stringify;
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    stream = await streamOpened.promise;
    await vi.waitFor(() => {
      expect(subscriptionsByApp.get("channels")).toBeTypeOf("number");
      expect(subscriptionsByApp.get("chat")).toBeTypeOf("number");
    });
    const channelsSubId = expectDefined(
      subscriptionsByApp.get("channels"),
      "channels subscription",
    );
    const chatSubId = expectDefined(subscriptionsByApp.get("chat"), "chat subscription");

    const buildNestedInlineJson = (depth: number, leafText: string, tailText?: string) => {
      const nested =
        depth > 0
          ? `${'{"bold":['.repeat(depth)}${JSON.stringify(leafText)}${"]}".repeat(depth)}`
          : JSON.stringify(leafText);
      return tailText
        ? `[{"inline":[${nested}]},{"inline":[${JSON.stringify(tailText)}]}]`
        : `[{"inline":[${nested}]}]`;
    };

    // 1) Event 25: native 100,000-level channel JSON, including native durable serialization.
    const nativeDeepGroupJson = `{"nest":"chat/~zod/general","response":{"post":{"id":"msg-native-100k","r-post":{"set":{"essay":{"author":"~nec","content":${buildNestedInlineJson(100_000, "x")},"sent":1700000000001}}}}}}`;
    stream.write(`id: 25\ndata: {"id":${channelsSubId},"json":${nativeDeepGroupJson}}\n\n`);
    await vi.waitFor(() => expect(ackedEventIds).toContain(25), { timeout: 2_000 });

    // 2) Event 26: 2,000-level channel message mentioning ~zod (serializes durably, exercises bounded extractor in handleChannelsFirehose).
    const deepGroupJson = `{"nest":"chat/~zod/general","response":{"post":{"id":"msg-deep-group-2k","r-post":{"set":{"essay":{"author":"~nec","content":${buildNestedInlineJson(2_000, "deep", "~zod group after deep")},"sent":1700000000002}}}}}}`;
    stream.write(`id: 26\ndata: {"id":${channelsSubId},"json":${deepGroupJson}}\n\n`);

    // 3) Event 27: ordinary group message after the deep messages.
    const normalGroupJson = JSON.stringify({
      nest: "chat/~zod/general",
      response: {
        post: {
          id: "msg-normal-group",
          "r-post": {
            set: {
              essay: {
                author: "~nec",
                content: [{ inline: ["~zod hello group"] }],
                sent: 1700000000003,
              },
            },
          },
        },
      },
    });
    stream.write(`id: 27\ndata: {"id":${channelsSubId},"json":${normalGroupJson}}\n\n`);

    // 4) Event 46: 2,000-level DM followed by visible text (exercises bounded extractor in handleChatFirehose + triggers second SSE ack threshold).
    const deepDmJson = `{"whom":"~bus","id":"dm-deep-2k","response":{"add":{"essay":{"author":"~bus","content":${buildNestedInlineJson(2_000, "deep", "dm after deep")},"sent":1700000000004}}}}`;
    stream.write(`id: 46\ndata: {"id":${chatSubId},"json":${deepDmJson}}\n\n`);

    // 5) Event 67: ordinary DM after the deep DM (triggers third SSE ack threshold).
    const normalDmJson = JSON.stringify({
      whom: "~bus",
      id: "dm-normal",
      response: {
        add: {
          essay: {
            author: "~bus",
            content: [{ inline: ["hello dm"] }],
            sent: 1700000000005,
          },
        },
      },
    });
    stream.write(`id: 67\ndata: {"id":${chatSubId},"json":${normalDmJson}}\n\n`);

    await vi.waitFor(
      () => {
        expect(ackedEventIds).toEqual([25, 46, 67]);
        expect(inboundRuntimeMock.buildContext).toHaveBeenCalledTimes(4);
        expect(inboundRuntimeMock.dispatch).toHaveBeenCalledTimes(4);
      },
      { timeout: 5_000 },
    );

    await realUrbitFixture.ingress?.waitForIdle();
    // A new transport id must not redispatch an already completed logical message.
    stream.write(
      "id: 88\ndata: " + JSON.stringify({ id: chatSubId, json: JSON.parse(normalDmJson) }) + "\n\n",
    );
    await vi.waitFor(() => expect(ackedEventIds).toEqual([25, 46, 67, 88]));
    await realUrbitFixture.ingress?.waitForIdle();
    expect(inboundRuntimeMock.dispatch).toHaveBeenCalledTimes(4);
    expect(await queue.listPending({ limit: "all" })).toEqual([]);

    const builtMessages = inboundRuntimeMock.buildContext.mock.calls.map((call) => {
      const [arg] = call as [
        { messageId: string; message: { rawBody: string; commandBody: string } },
      ];
      return {
        messageId: arg.messageId,
        rawBody: arg.message.rawBody,
        commandBody: arg.message.commandBody,
      };
    });
    expect(builtMessages).toEqual([
      {
        messageId: "msg-deep-group-2k",
        rawBody: `${"**".repeat(200)}\n~zod group after deep`,
        commandBody: `${"**".repeat(200)}\n group after deep`,
      },
      {
        messageId: "msg-normal-group",
        rawBody: "~zod hello group",
        commandBody: "hello group",
      },
      {
        messageId: "dm-deep-2k",
        rawBody: `${"**".repeat(200)}\ndm after deep`,
        commandBody: `${"**".repeat(200)}\ndm after deep`,
      },
      {
        messageId: "dm-normal",
        rawBody: "hello dm",
        commandBody: "hello dm",
      },
    ]);
    // First prove native serialization (including the 100,000-level JSON) and
    // four exact rendered contexts. Node v26.12.1 does not naturally overflow.
    // Inject RangeError only for these two synthetic message identities at the
    // real JSON.stringify boundary; HTTP, SSE, parsing and the queue stay real.
    stringify.mockImplementation((value: unknown, replacer, space) => {
      const event = asNullableRecord(value);
      const post = asNullableRecord(asNullableRecord(event?.response)?.post);
      if (
        (event?.nest === "chat/~zod/general" && post?.id === "msg-poison-100k") ||
        (event?.whom === "~bus" && event?.id === "dm-poison-100k")
      ) {
        throw new RangeError("Synthetic Tlon ingress serialization failure");
      }
      return nativeStringify(value, replacer, space);
    });
    const serializationFaultGroupJson = nativeDeepGroupJson.replace(
      "msg-native-100k",
      "msg-poison-100k",
    );
    stream.write(
      `id: 109\ndata: {"id":${channelsSubId},"json":${serializationFaultGroupJson}}\n\n`,
    );
    await vi.waitFor(() => expect(ackedEventIds).toEqual([25, 46, 67, 88, 109]));
    await realUrbitFixture.ingress?.waitForIdle();
    expect(runtime.log).toHaveBeenCalledWith(
      "tlon dropped channels event: Tlon firehose event is too deeply nested to store.",
    );
    expect(inboundRuntimeMock.buildContext).toHaveBeenCalledTimes(4);
    expect(inboundRuntimeMock.dispatch).toHaveBeenCalledTimes(4);
    expect(await queue.listPending({ limit: "all" })).toEqual([]);
    expect(await queue.listClaims()).toEqual([]);

    // The chat subscription must drop the same synthetic serialization fault as channels.
    const serializationFaultDmJson = `{"whom":"~bus","id":"dm-poison-100k","response":{"add":{"essay":{"author":"~bus","content":${buildNestedInlineJson(100_000, "x")},"sent":1700000000006}}}}`;
    stream.write(`id: 130\ndata: {"id":${chatSubId},"json":${serializationFaultDmJson}}\n\n`);
    await vi.waitFor(() => expect(ackedEventIds).toEqual([25, 46, 67, 88, 109, 130]));
    await realUrbitFixture.ingress?.waitForIdle();
    expect(runtime.log).toHaveBeenCalledWith(
      "tlon dropped chat event: Tlon firehose event is too deeply nested to store.",
    );
    expect(inboundRuntimeMock.buildContext).toHaveBeenCalledTimes(4);
    expect(inboundRuntimeMock.dispatch).toHaveBeenCalledTimes(4);
    expect(await queue.listPending({ limit: "all" })).toEqual([]);
    expect(await queue.listClaims()).toEqual([]);

    // Synthetic renderer fault, not remotely reachable JSON: only the native trim
    // of this exact text throws. Keep real decoding, rendering and ingress settlement.
    const failureText = "synthetic private renderer failure";
    // Capture before spying; every invocation below supplies the original string receiver.
    // oxlint-disable-next-line typescript/unbound-method
    const nativeTrim = String.prototype.trim;
    const trim = vi.spyOn(String.prototype, "trim").mockImplementation(function (this: string) {
      if (this === failureText) {
        throw new Error(failureText);
      }
      return nativeTrim.call(this);
    });
    const enqueue = vi.spyOn(queue, "enqueue");
    try {
      const failedGroupJson = normalGroupJson
        .replace("msg-normal-group", "msg-render-failure-group")
        .replace("~zod hello group", failureText);
      const failedDmJson = normalDmJson
        .replace("dm-normal", "dm-render-failure")
        .replace("hello dm", failureText);
      stream.write(`id: 151\ndata: {"id":${channelsSubId},"json":${failedGroupJson}}\n\n`);
      stream.write(`id: 172\ndata: {"id":${chatSubId},"json":${failedDmJson}}\n\n`);
      await vi.waitFor(() => expect(ackedEventIds).toEqual([25, 46, 67, 88, 109, 130, 151, 172]));
      await realUrbitFixture.ingress?.waitForIdle();
      expect(
        runtime.log.mock.calls.filter(
          ([message]) => message === "[tlon] Failed to extract message text",
        ),
      ).toHaveLength(2);
      expect(inboundRuntimeMock.buildContext).toHaveBeenCalledTimes(4);
      expect(inboundRuntimeMock.dispatch).toHaveBeenCalledTimes(4);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      expect(await queue.listClaims()).toEqual([]);
      expect(
        await expectDefined(queue.listFailed?.bind(queue), "queue listFailed")({ limit: "all" }),
      ).toEqual([]);

      // Keep the fault armed: replay must dedupe completed records, not rerender.
      stream.write(`id: 193\ndata: {"id":${channelsSubId},"json":${failedGroupJson}}\n\n`);
      stream.write(`id: 214\ndata: {"id":${chatSubId},"json":${failedDmJson}}\n\n`);
      await vi.waitFor(() =>
        expect(ackedEventIds).toEqual([25, 46, 67, 88, 109, 130, 151, 172, 193, 214]),
      );
      await realUrbitFixture.ingress?.waitForIdle();
      expect(await Promise.all(enqueue.mock.results.map((result) => result.value))).toMatchObject([
        { kind: "accepted" },
        { kind: "accepted" },
        { kind: "completed", duplicate: true },
        { kind: "completed", duplicate: true },
      ]);
      expect(
        runtime.log.mock.calls.filter(
          ([message]) => message === "[tlon] Failed to extract message text",
        ),
      ).toHaveLength(2);
      expect(
        runtime.log.mock.calls.filter(([message]) => String(message).includes(failureText)),
      ).toEqual([]);
      expect(inboundRuntimeMock.dispatch).toHaveBeenCalledTimes(4);
    } finally {
      trim.mockRestore();
      enqueue.mockRestore();
    }

    // New logical messages on both subscriptions progress after both poison paths.
    const nextGroupJson = normalGroupJson.replace("msg-normal-group", "msg-after-poison-group");
    const nextDmJson = normalDmJson.replace("dm-normal", "dm-after-poison");
    stream.write(`id: 235\ndata: {"id":${channelsSubId},"json":${nextGroupJson}}\n\n`);
    stream.write(`id: 256\ndata: {"id":${chatSubId},"json":${nextDmJson}}\n\n`);
    await vi.waitFor(() => {
      expect(ackedEventIds).toEqual([25, 46, 67, 88, 109, 130, 151, 172, 193, 214, 235, 256]);
      expect(inboundRuntimeMock.dispatch).toHaveBeenCalledTimes(6);
    });
    await realUrbitFixture.ingress?.waitForIdle();
    expect(
      inboundRuntimeMock.buildContext.mock.calls.slice(4).map(([message]) => message),
    ).toMatchObject([
      { messageId: "msg-after-poison-group", message: { rawBody: "~zod hello group" } },
      { messageId: "dm-after-poison", message: { rawBody: "hello dm" } },
    ]);
    expect(await queue.listPending({ limit: "all" })).toEqual([]);
    expect(await queue.listClaims()).toEqual([]);
    expect(
      await expectDefined(queue.listFailed?.bind(queue), "queue listFailed")({ limit: "all" }),
    ).toEqual([]);
  } finally {
    stringify.mockRestore();
    controller.abort();
    stream?.end();
    await monitor.catch(() => undefined);
    await scheduler.stop();
    closeOpenClawStateDatabaseForTest();
  }
});
