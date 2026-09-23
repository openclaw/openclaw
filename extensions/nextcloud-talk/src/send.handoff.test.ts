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

const registrations = [
  {
    name: "message text",
    media: false,
    send: (ctx: SendContext) => nextcloudTalkPlugin.message?.send?.text?.(ctx),
  },
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
  {
    name: "outbound media",
    media: true,
    send: (ctx: SendContext) => nextcloudTalkPlugin.outbound?.sendMedia?.(ctx),
  },
];

function sendContext(baseUrl: string): SendContext {
  return {
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
  };
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
    const requests: Array<{ method?: string; url?: string; body: string }> = [];
    await withServer(
      (request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.once("end", () => {
          requests.push({ method: request.method, url: request.url, body });
          acceptMessage(response);
        });
        request.once("error", () => response.destroy());
      },
      async (baseUrl) => {
        await expect(
          send({ ...sendContext(baseUrl), ...handoff.callbacks }),
        ).resolves.toMatchObject({
          messageId: "42",
          receipt: { platformMessageIds: ["42"], replyToId: "parent-1" },
        });
      },
    );
    expect(requests).toEqual([
      {
        method: "POST",
        url: "/ocs/v2.php/apps/spreed/api/v1/bot/allowed/message",
        body: JSON.stringify({
          message: media ? "hello\n\nAttachment: https://example.com/image.png" : "hello",
          replyTo: "parent-1",
        }),
      },
    ]);
    expect(handoff.callbacks.onPlatformSendDispatch).toHaveBeenCalledOnce();
  });

  it("blocks the POST when delivery is cancelled during DNS preparation", async () => {
    const handoff = createHandoff();
    const started = createDeferred<void>();
    const resume = createDeferred<void>();
    const requests: string[] = [];
    transport.beforeLookup = async () => {
      started.resolve();
      await resume.promise;
    };
    await withServer(
      (request, response) => {
        requests.push(request.url ?? "");
        request.resume();
        acceptMessage(response);
      },
      async (baseUrl) => {
        const pending = Promise.resolve(send({ ...sendContext(baseUrl), ...handoff.callbacks }));
        const result = pending.catch((error: unknown) => error);
        try {
          const ready = await Promise.race([
            started.promise.then(() => true),
            result.then(() => false),
          ]);
          expect(ready).toBe(true);
          handoff.cancel();
        } finally {
          resume.resolve();
          await result;
        }
        expect(await result).toBe(handoff.error);
      },
    );
    expect(requests).toEqual([]);
  });

  it.each([false, true])("rechecks redirects with delivery cancelled=%s", async (cancelled) => {
    const handoff = createHandoff();
    const requests: string[] = [];
    await withServer(
      (request, response) => {
        requests.push(`${request.method} ${request.url}`);
        request.resume();
        if (requests.length === 1) {
          if (cancelled) {
            handoff.cancel();
          }
          response.writeHead(307, { location: "/redirected-message" });
          response.end();
        } else {
          acceptMessage(response);
        }
      },
      async (baseUrl) => {
        const pending = Promise.resolve(send({ ...sendContext(baseUrl), ...handoff.callbacks }));
        if (cancelled) {
          await expect(pending).rejects.toBe(handoff.error);
        } else {
          await expect(pending).resolves.toMatchObject({ messageId: "42" });
        }
      },
    );
    expect(requests).toEqual([
      "POST /ocs/v2.php/apps/spreed/api/v1/bot/allowed/message",
      ...(!cancelled ? ["POST /redirected-message"] : []),
    ]);
  });

  it.each([false, true])(
    "preserves an accepted send after cancellation with valid body=%s",
    async (validBody) => {
      const handoff = createHandoff();
      await withServer(
        (request, response) => {
          request.resume();
          handoff.cancel();
          acceptMessage(response, validBody);
        },
        async (baseUrl) => {
          await expect(
            send({ ...sendContext(baseUrl), ...handoff.callbacks }),
          ).resolves.toMatchObject({
            messageId: validBody ? "42" : "unknown",
            receipt: { platformMessageIds: validBody ? ["42"] : [] },
          });
        },
      );
    },
  );
});

it.each(["reject", "cancel"])(
  "settles an asynchronous dispatch hook before HTTP (%s)",
  async (mode) => {
    const handoff = createHandoff();
    const started = createDeferred<void>();
    const resume = createDeferred<void>();
    const requests: string[] = [];
    handoff.callbacks.onPlatformSendDispatch.mockImplementation(async () => {
      started.resolve();
      await resume.promise;
      if (mode === "reject") {
        throw handoff.error;
      }
    });
    await withServer(
      (request, response) => {
        requests.push(request.url ?? "");
        request.resume();
        acceptMessage(response);
      },
      async (baseUrl) => {
        const pending = nextcloudTalkPlugin.message?.send?.text?.({
          ...sendContext(baseUrl),
          ...handoff.callbacks,
        });
        const result = Promise.resolve(pending).catch((error: unknown) => error);
        try {
          await Promise.race([started.promise, result]);
          expect(handoff.callbacks.onPlatformSendDispatch).toHaveBeenCalledOnce();
          expect(requests).toEqual([]);
          handoff.cancel();
        } finally {
          resume.resolve();
          await result;
        }
        expect(await result).toBe(handoff.error);
      },
    );
    expect(requests).toEqual([]);
  },
);

it("keeps a cancelled send's authority separate from a concurrent delivery", async () => {
  const cancelled = createHandoff();
  const current = createHandoff();
  const started = createDeferred<void>();
  const resume = createDeferred<void>();
  const requests: string[] = [];
  transport.beforeLookup = async (url) => {
    if (url.includes("/held/")) {
      started.resolve();
      await resume.promise;
    }
  };
  await withServer(
    (request, response) => {
      requests.push(request.url ?? "");
      request.resume();
      acceptMessage(response);
    },
    async (baseUrl) => {
      const held = nextcloudTalkPlugin.message?.send?.text?.({
        ...sendContext(baseUrl),
        ...cancelled.callbacks,
        to: "room:held",
      });
      const result = Promise.resolve(held).catch((error: unknown) => error);
      try {
        const ready = await Promise.race([
          started.promise.then(() => true),
          result.then(() => false),
        ]);
        expect(ready).toBe(true);
        cancelled.cancel();
        await expect(
          nextcloudTalkPlugin.outbound?.sendMedia?.({
            ...sendContext(baseUrl),
            ...current.callbacks,
          }),
        ).resolves.toMatchObject({ messageId: "42" });
      } finally {
        resume.resolve();
        await result;
      }
      expect(await result).toBe(cancelled.error);
    },
  );
  expect(requests).toEqual(["/ocs/v2.php/apps/spreed/api/v1/bot/allowed/message"]);
});
