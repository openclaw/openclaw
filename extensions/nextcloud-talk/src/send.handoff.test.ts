import type { ServerResponse } from "node:http";
import type { ChannelMessageSendMediaContext } from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const sendText = (ctx: SendContext) => nextcloudTalkPlugin.message?.send?.text?.(ctx);
const sendMedia = (ctx: SendContext) => nextcloudTalkPlugin.outbound?.sendMedia?.(ctx);
const registrations = [
  { name: "message text", media: false, send: sendText },
  {
    name: "message media",
    media: true,
    send: (ctx: SendContext) => nextcloudTalkPlugin.message?.send?.media?.(ctx),
  },
  {
    name: "outbound text",
    media: false,
    send: (ctx: SendContext) => nextcloudTalkPlugin.outbound?.sendText?.(ctx),
  },
  { name: "outbound media", media: true, send: sendMedia },
];
const MESSAGE_PATH = "/ocs/v2.php/apps/spreed/api/v1/bot/allowed/message";

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
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        recorded.body += chunk;
      });
      request.once("end", () => {
        respond(response, requests);
      });
      request.once("error", () => response.destroy());
    },
    async (baseUrl) =>
      run(
        {
          cfg: {
            channels: {
              "nextcloud-talk": {
                accounts: {
                  work: {
                    baseUrl,
                    botSecret: "synthetic-bot-secret",
                    network: { dangerouslyAllowPrivateNetwork: true },
                  },
                },
              },
            },
          },
          accountId: "work",
          to: "room:allowed",
          text: "hello",
          mediaUrl: "https://example.com/image.png",
          replyToId: "parent-1",
        },
        requests,
      ),
  );
  return requests;
}

function createHandoff() {
  let current = true;
  const error = new Error("Nextcloud delivery cancelled");
  return {
    error,
    cancel: () => {
      current = false;
    },
    callbacks: {
      onPlatformSendDispatch: vi.fn(async () => {}),
      assertDirectAdapterHandoff: () => {
        if (!current) {
          throw error;
        }
      },
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

describe.each(registrations)("Nextcloud Talk $name handoff", ({ send, media }) => {
  it("preserves message content, the dispatch hook, and the accepted receipt", async () => {
    const handoff = createHandoff();
    const requests = await withTalkServer(async (ctx) => {
      await expect(send({ ...ctx, ...handoff.callbacks })).resolves.toMatchObject({
        messageId: "42",
        receipt: { platformMessageIds: ["42"], replyToId: "parent-1" },
      });
    });
    expect(requests).toEqual([
      {
        method: "POST",
        url: MESSAGE_PATH,
        body: JSON.stringify({
          message: media ? "hello\n\nAttachment: https://example.com/image.png" : "hello",
          replyTo: "parent-1",
        }),
      },
    ]);
    expect(handoff.callbacks.onPlatformSendDispatch).toHaveBeenCalledOnce();
  });

  it("blocks a send cancelled during DNS without cancelling a concurrent delivery", async () => {
    const cancelled = createHandoff();
    const current = createHandoff();
    const started = createDeferred<void>();
    const resume = createDeferred<void>();
    transport.beforeLookup = async (url) => {
      if (url.includes("/held/")) {
        started.resolve();
        await resume.promise;
      }
    };
    const requests = await withTalkServer(async (ctx) => {
      const result = Promise.resolve(
        send({ ...ctx, ...cancelled.callbacks, to: "room:held" }),
      ).catch((error: unknown) => error);
      try {
        expect(
          await Promise.race([started.promise.then(() => true), result.then(() => false)]),
        ).toBe(true);
        cancelled.cancel();
        await expect(sendMedia({ ...ctx, ...current.callbacks })).resolves.toMatchObject({
          messageId: "42",
        });
      } finally {
        resume.resolve();
        await result;
      }
      expect(await result).toBe(cancelled.error);
    });
    expect(requests.map((request) => request.url)).toEqual([MESSAGE_PATH]);
  });
});

// All registrations above reach the same guarded sender; exercise its deeper lifecycle once.
it.each([false, true])("rechecks redirects with delivery cancelled=%s", async (cancelled) => {
  const handoff = createHandoff();
  const requests = await withTalkServer(
    async (ctx) => {
      const pending = Promise.resolve(sendMedia({ ...ctx, ...handoff.callbacks }));
      if (cancelled) {
        await expect(pending).rejects.toBe(handoff.error);
      } else {
        await expect(pending).resolves.toMatchObject({ messageId: "42" });
      }
    },
    (response, received) => {
      if (received.length === 1) {
        if (cancelled) {
          handoff.cancel();
        }
        response.writeHead(307, { location: "/redirected-message" });
        response.end();
      } else {
        acceptMessage(response);
      }
    },
  );
  expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
    `POST ${MESSAGE_PATH}`,
    ...(!cancelled ? ["POST /redirected-message"] : []),
  ]);
});

it.each([false, true])(
  "preserves an accepted send after cancellation with valid body=%s",
  async (validBody) => {
    const handoff = createHandoff();
    await withTalkServer(
      async (ctx) => {
        await expect(sendMedia({ ...ctx, ...handoff.callbacks })).resolves.toMatchObject({
          messageId: validBody ? "42" : "unknown",
          receipt: { platformMessageIds: validBody ? ["42"] : [] },
        });
      },
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
    const started = createDeferred<void>();
    const resume = createDeferred<void>();
    handoff.callbacks.onPlatformSendDispatch.mockImplementation(async () => {
      started.resolve();
      await resume.promise;
      if (mode === "reject") {
        throw handoff.error;
      }
    });
    const requests = await withTalkServer(async (ctx, received) => {
      const result = Promise.resolve(sendText({ ...ctx, ...handoff.callbacks })).catch(
        (error: unknown) => error,
      );
      try {
        await Promise.race([started.promise, result]);
        expect(handoff.callbacks.onPlatformSendDispatch).toHaveBeenCalledOnce();
        expect(received).toEqual([]);
        handoff.cancel();
      } finally {
        resume.resolve();
        await result;
      }
      expect(await result).toBe(handoff.error);
    });
    expect(requests).toEqual([]);
  },
);
