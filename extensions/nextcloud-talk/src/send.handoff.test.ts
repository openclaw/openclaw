import type { ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { expectDefined } from "@openclaw/normalization-core";
import type { ChannelMessageSendMediaContext } from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { nextcloudTalkPlugin } from "../channel-plugin-api.js";

const transport = vi.hoisted(() => ({
  beforeLookup: undefined as ((url: string) => Promise<void> | void) | undefined,
}));
vi.mock("../runtime-api.js", async (original) => {
  const actual = await original<typeof import("../runtime-api.js")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      actual.fetchWithSsrFGuard({
        ...params,
        // Keep the real guard and pinned HTTP transport, with deterministic fixture DNS.
        lookupFn: async () => {
          await transport.beforeLookup?.(params.url);
          return [{ address: "127.0.0.1", family: 4 }];
        },
      }),
  };
});

type SendContext = Pick<
  ChannelMessageSendMediaContext,
  | "cfg"
  | "to"
  | "text"
  | "mediaUrl"
  | "accountId"
  | "replyToId"
  | "onPlatformSendDispatch"
  | "assertDirectAdapterHandoff"
>;

const sendText = expectDefined(nextcloudTalkPlugin.message?.send?.text, "text sender");
const sendMedia = expectDefined(nextcloudTalkPlugin.outbound?.sendMedia, "media sender");
const MESSAGE_PATH = "/ocs/v2.php/apps/spreed/api/v1/bot/allowed/message";
const MEDIA_MESSAGE = "hello\n\nAttachment: https://example.com/image.png";

type RecordedRequest = { method?: string; url?: string; body: string };
async function withTalkServer(
  run: (ctx: SendContext, requests: RecordedRequest[]) => Promise<void>,
  respond: (response: ServerResponse, requests: RecordedRequest[]) => void = (response) =>
    acceptMessage(response),
) {
  const requests: RecordedRequest[] = [];
  await withServer(
    (request, response) => {
      const recorded = { method: request.method, url: request.url, body: "" };
      requests.push(recorded);
      void text(request).then(
        (body) => {
          recorded.body = body;
          respond(response, requests);
        },
        () => response.destroy(),
      );
    },
    async (baseUrl) => {
      const work = {
        baseUrl,
        botSecret: "synthetic-bot-secret",
        network: { dangerouslyAllowPrivateNetwork: true },
      };
      await run(
        {
          cfg: { channels: { "nextcloud-talk": { accounts: { work } } } },
          accountId: "work",
          to: "room:allowed",
          text: "hello",
          mediaUrl: "https://example.com/image.png",
          replyToId: "parent-1",
        },
        requests,
      );
    },
  );
  return requests;
}

function createGate() {
  const started = createDeferred<void>();
  const resume = createDeferred<void>();
  return {
    async block() {
      started.resolve();
      await resume.promise;
    },
    async during(pending: Promise<unknown>, check: () => void | Promise<void>) {
      const result = pending.catch((error: unknown) => error);
      try {
        expect(
          await Promise.race([started.promise.then(() => true), result.then(() => false)]),
        ).toBe(true);
        await check();
      } finally {
        resume.resolve();
        await result;
      }
      return result;
    },
  };
}

function createHandoff() {
  const controller = new AbortController();
  const error = new Error("Nextcloud delivery cancelled");
  return {
    error,
    cancel: () => controller.abort(error),
    callbacks: {
      onPlatformSendDispatch: vi.fn(async () => {}),
      assertDirectAdapterHandoff: () => controller.signal.throwIfAborted(),
    },
  };
}
function acceptMessage(response: ServerResponse, validBody = true) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(validBody ? JSON.stringify({ ocs: { data: { id: 42 } } }) : "invalid-json");
}
afterEach(() => {
  transport.beforeLookup = undefined;
});

it.each([
  { name: "message text", media: false, send: sendText },
  { name: "outbound media", media: true, send: sendMedia },
])(
  "blocks $name cancelled during DNS without cancelling a concurrent delivery",
  async ({ send, media }) => {
    const cancelled = createHandoff();
    const current = createHandoff();
    const gate = createGate();
    transport.beforeLookup = async (url) => {
      if (url.includes("/held/")) {
        await gate.block();
      }
    };
    const requests = await withTalkServer(async (ctx) => {
      const result = await gate.during(
        send({ ...ctx, ...cancelled.callbacks, to: "room:held" }),
        async () => {
          cancelled.cancel();
          await expect(send({ ...ctx, ...current.callbacks })).resolves.toMatchObject({
            messageId: "42",
            receipt: { platformMessageIds: ["42"], replyToId: "parent-1" },
          });
        },
      );
      expect(result).toBe(cancelled.error);
    });
    const message = media ? MEDIA_MESSAGE : "hello";
    const body = JSON.stringify({ message, replyTo: "parent-1" });
    expect(requests).toEqual([{ method: "POST", url: MESSAGE_PATH, body }]);
    expect(current.callbacks.onPlatformSendDispatch).toHaveBeenCalledOnce();
  },
);

it("rejects a redirect after delivery cancellation", async () => {
  const handoff = createHandoff();
  const requests = await withTalkServer(
    (ctx) => expect(sendMedia({ ...ctx, ...handoff.callbacks })).rejects.toBe(handoff.error),
    (response, received) => {
      if (received.length === 1) {
        handoff.cancel();
        response.writeHead(307, { location: "/redirected-message" });
        response.end();
      } else {
        acceptMessage(response);
      }
    },
  );
  expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
    `POST ${MESSAGE_PATH}`,
  ]);
});

it.each([false, true])(
  "preserves an accepted send after cancellation with valid body=%s",
  async (validBody) => {
    const handoff = createHandoff();
    await withTalkServer(
      (ctx) =>
        expect(sendMedia({ ...ctx, ...handoff.callbacks })).resolves.toMatchObject({
          messageId: validBody ? "42" : "unknown",
          receipt: { platformMessageIds: validBody ? ["42"] : [] },
        }),
      (response) => {
        handoff.cancel();
        acceptMessage(response, validBody);
      },
    );
  },
);

it.each(["reject", "cancel"])(
  "settles an asynchronous dispatch hook before HTTP (%s)",
  async (mode) => {
    const handoff = createHandoff();
    const gate = createGate();
    handoff.callbacks.onPlatformSendDispatch.mockImplementation(async () => {
      await gate.block();
      if (mode === "reject") {
        throw handoff.error;
      }
    });
    const requests = await withTalkServer(async (ctx, received) => {
      const result = await gate.during(sendText({ ...ctx, ...handoff.callbacks }), () => {
        expect(handoff.callbacks.onPlatformSendDispatch).toHaveBeenCalledOnce();
        expect(received).toEqual([]);
        if (mode === "cancel") {
          handoff.cancel();
        }
      });
      expect(result).toBe(handoff.error);
    });
    expect(requests).toEqual([]);
  },
);
