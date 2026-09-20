import type { ChannelMessageSendResult } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tlonPlugin } from "./channel.js";

const IMAGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5x0AAAAASUVORK5CYII=",
  "base64",
);
const RECIPIENT = "~sampel-palnet";
type Storage = "memex" | "s3";
type Phase =
  | "source"
  | "login"
  | "storage"
  | "credentials"
  | "secret"
  | "allocation"
  | "upload"
  | "poke";
type RequestRecord = { phase: Phase; url: string; dispatchCount: number };
const fixtureCleanups: Array<() => Promise<void>> = [];

function createAccount(ship: string, storage: Storage) {
  const requests: RequestRecord[] = [];
  const pokes: unknown[] = [];
  return {
    ship,
    storage,
    shipUrl: `https://${ship}.${storage === "memex" ? "tlon.network" : "ship.example"}`,
    sourceUrl: `https://media.example/${ship}.png`,
    allocationUrl: `https://memex.tlon.network/v1/${ship}/upload`,
    uploadUrl: `https://uploads.tlon.network/${ship}/upload`,
    hostedUrl: `https://files.tlon.network/${ship}/image.png`,
    s3Endpoint: `https://${ship}.s3.example`,
    publicUrlBase: `https://${ship}.files.example/`,
    code: `fake-code-${ship}`,
    accessKeyId: `TESTACCESSKEY${ship.toUpperCase()}`,
    controller: new AbortController(),
    revoked: new Error(`Tlon ${ship} delivery authority revoked`),
    onPlatformSendDispatch: vi.fn(async () => {}),
    uploadCanceled: vi.fn(),
    requests,
    pokes,
  };
}

type Account = ReturnType<typeof createAccount>;

function createFixture(
  accounts: Account[],
  pauseAt?: { ship: string; phase: Phase },
  failUpload = false,
) {
  const entered = createDeferred<Response>();
  const resume = createDeferred<void>();
  const pending: Promise<unknown>[] = [];
  fixtureCleanups.push(async () => {
    for (const account of accounts) {
      account.controller.abort(account.revoked);
    }
    resume.resolve();
    await Promise.allSettled(pending);
  });
  const cfg = {
    channels: {
      tlon: {
        accounts: Object.fromEntries(
          accounts.map(
            (account) =>
              [
                account.ship,
                {
                  ship: `~${account.ship}`,
                  url: account.shipUrl,
                  code: account.code,
                  mediaMaxMb: 1,
                },
              ] as const,
          ),
        ),
      },
    },
  } satisfies OpenClawConfig;

  // Only the final HTTP boundary is replaced; registration, preparation,
  // authentication, signing, and the guarded-fetch request check remain real.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const account = accounts.find(
        (candidate) =>
          url.href === candidate.sourceUrl ||
          url.origin === candidate.shipUrl ||
          url.href === candidate.allocationUrl ||
          url.href === candidate.uploadUrl ||
          url.origin === candidate.s3Endpoint,
      );
      if (!account) {
        throw new Error(`Unexpected Tlon fixture request: ${url.origin}${url.pathname}`);
      }

      let phase: Phase;
      if (url.href === account.sourceUrl) {
        phase = "source";
      } else if (url.href === account.allocationUrl) {
        phase = "allocation";
      } else if (url.href === account.uploadUrl || url.origin === account.s3Endpoint) {
        phase = "upload";
      } else if (url.pathname === "/~/login") {
        phase = "login";
      } else if (url.pathname === "/~/scry/storage/configuration.json") {
        phase = "storage";
      } else if (url.pathname === "/~/scry/storage/credentials.json") {
        phase = "credentials";
      } else if (url.pathname === "/~/scry/genuine/secret.json") {
        phase = "secret";
      } else if (url.pathname.startsWith("/~/channel/")) {
        phase = "poke";
      } else {
        throw new Error(`Unexpected Tlon fixture path: ${url.pathname}`);
      }
      account.requests.push({
        phase,
        url: url.href,
        dispatchCount: account.onPlatformSendDispatch.mock.calls.length,
      });
      const method = init?.method ?? "GET";
      expect(method).toBe(
        phase === "login"
          ? "POST"
          : phase === "allocation" || phase === "upload" || phase === "poke"
            ? "PUT"
            : "GET",
      );
      if (url.origin === account.shipUrl && phase !== "login") {
        expect(new Headers(init?.headers).get("cookie")).toContain(
          `urbauth-~${account.ship}=fake-cookie-${account.ship}`,
        );
      }

      let response: Response;
      switch (phase) {
        case "source":
          response = new Response(IMAGE, { headers: { "Content-Type": "image/png" } });
          break;
        case "login":
          expect(init?.body).toBe(`password=${account.code}`);
          response = new Response("ok", {
            headers: {
              "Set-Cookie": `urbauth-~${account.ship}=fake-cookie-${account.ship}; Path=/; HttpOnly`,
            },
          });
          break;
        case "storage":
          response = Response.json({
            currentBucket: "media",
            buckets: ["media"],
            region: "us-east-1",
            publicUrlBase: account.publicUrlBase,
            presignedUrl: "",
            service: account.storage === "memex" ? "presigned-url" : "credentials",
          });
          break;
        case "credentials":
          response = Response.json({
            "storage-update":
              account.storage === "memex"
                ? {}
                : {
                    credentials: {
                      endpoint: account.s3Endpoint,
                      accessKeyId: account.accessKeyId,
                      secretAccessKey: `fake-secret-${account.ship}`,
                    },
                  },
          });
          break;
        case "secret":
          response = Response.json({ secret: `fake-genuine-${account.ship}` });
          break;
        case "allocation": {
          if (typeof init?.body !== "string") {
            throw new Error("Expected the Memex allocation JSON body");
          }
          const body: unknown = JSON.parse(init.body);
          expect(body).toMatchObject({
            token: `fake-genuine-${account.ship}`,
            contentLength: IMAGE.byteLength,
            contentType: "image/png",
            fileName: expect.stringMatching(
              new RegExp(`^${account.ship}/.+-${account.ship}\\.png$`),
            ),
          });
          response = Response.json({ url: account.uploadUrl, filePath: account.hostedUrl });
          break;
        }
        case "upload":
          if (!(init?.body instanceof Blob)) {
            throw new Error("Expected the Tlon image upload body");
          }
          expect(Buffer.from(await init.body.arrayBuffer())).toEqual(IMAGE);
          response = new Response(
            new ReadableStream<Uint8Array>({ cancel: account.uploadCanceled }),
            {
              status: failUpload ? 503 : 200,
            },
          );
          break;
        case "poke": {
          if (typeof init?.body !== "string") {
            throw new Error("Expected the Tlon poke JSON body");
          }
          const body: unknown = JSON.parse(init.body);
          account.pokes.push(body);
          response = new Response(null, { status: 204 });
          break;
        }
      }
      if (pauseAt?.ship === account.ship && pauseAt.phase === phase) {
        entered.resolve(response);
        await resume.promise;
      }
      return response;
    }),
  );

  const send = tlonPlugin.message?.send?.media;
  if (!send) {
    throw new Error("Expected the preferred Tlon media sender");
  }
  return {
    entered: entered.promise,
    resume: () => resume.resolve(),
    send: (account: Account) => {
      const result = send({
        cfg,
        accountId: account.ship,
        to: RECIPIENT,
        text: `Photo from ${account.ship}`,
        mediaUrl: account.sourceUrl,
        assertDirectAdapterHandoff: () => account.controller.signal.throwIfAborted(),
        onPlatformSendDispatch: account.onPlatformSendDispatch,
      });
      pending.push(result.catch(() => undefined));
      return result;
    },
  };
}

function getUploadedUrl(account: Account): string {
  const uploads = account.requests.filter(({ phase }) => phase === "upload");
  expect(uploads).toHaveLength(1);
  const upload = uploads[0];
  if (!upload) {
    throw new Error("Expected an image upload before the Tlon poke");
  }
  if (account.storage === "memex") {
    return account.hostedUrl;
  }
  const signed = new URL(upload.url);
  expect(signed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
  expect(signed.searchParams.get("X-Amz-Credential")).toMatch(
    new RegExp(`^${account.accessKeyId}/\\d{8}/us-east-1/s3/aws4_request$`),
  );
  expect(signed.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  expect(signed.pathname).toMatch(new RegExp(`^/media/${account.ship}/.+-${account.ship}\\.png$`));
  return new URL(signed.pathname.slice("/media/".length), account.publicUrlBase).href;
}

function expectDelivered(account: Account, result: ChannelMessageSendResult, mediaUrl: string) {
  expect(result).toMatchObject({
    messageId: expect.stringMatching(new RegExp(`^~${account.ship}/`)),
    receipt: { parts: [{ kind: "media" }] },
  });
  expect(account.pokes).toHaveLength(1);
  expect(account.pokes[0]).toMatchObject([
    {
      action: "poke",
      ship: account.ship,
      app: "chat",
      mark: "chat-dm-action",
      json: {
        ship: RECIPIENT,
        diff: {
          delta: {
            add: {
              memo: {
                author: `~${account.ship}`,
                content: [
                  { inline: [`Photo from ${account.ship}`] },
                  { block: { image: { src: mediaUrl } } },
                ],
              },
            },
          },
        },
      },
    },
  ]);
  expect(account.onPlatformSendDispatch).toHaveBeenCalledTimes(1);
  expect(
    account.requests.every(
      ({ phase, dispatchCount }) => dispatchCount === (phase === "poke" ? 1 : 0),
    ),
  ).toBe(true);
}

afterEach(async () => {
  for (const cleanup of fixtureCleanups.splice(0)) {
    await cleanup();
  }
  vi.unstubAllGlobals();
});

describe("Tlon preferred media send authority", () => {
  it.each(["memex", "s3"] as const)(
    "uploads through %s before delivering the image",
    async (storage) => {
      const account = createAccount("zod", storage);
      const fixture = createFixture([account]);

      const result = await fixture.send(account);

      expectDelivered(account, result, getUploadedUrl(account));
      expect(account.uploadCanceled).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { storage: "memex", phase: "source" },
    { storage: "memex", phase: "allocation" },
    { storage: "s3", phase: "storage" },
    { storage: "s3", phase: "upload" },
  ] satisfies Array<{ storage: Storage; phase: Phase }>)(
    "stops later requests when authority closes during $storage $phase",
    async ({ storage, phase }) => {
      const account = createAccount("zod", storage);
      const fixture = createFixture([account], { ship: account.ship, phase });
      const result = fixture.send(account).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await fixture.entered;
      const submitted = [...account.requests];
      account.controller.abort(account.revoked);
      fixture.resume();

      expect(await result).toEqual({ error: account.revoked });
      expect(account.requests).toEqual(submitted);
      expect(account.pokes).toEqual([]);
      expect(account.onPlatformSendDispatch).not.toHaveBeenCalled();
      if (phase === "upload") {
        expect(account.uploadCanceled).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("retains the original image URL after an ordinary storage failure", async () => {
    const account = createAccount("zod", "memex");
    const fixture = createFixture([account], undefined, true);

    const result = await fixture.send(account);

    expectDelivered(account, result, account.sourceUrl);
    expect(account.requests.filter(({ phase }) => phase === "upload")).toHaveLength(1);
    expect(account.uploadCanceled).toHaveBeenCalledTimes(1);
  });

  it("keeps an earlier media send on its own account after another account completes and closes", async () => {
    const first = createAccount("zod", "memex");
    const second = createAccount("nec", "s3");
    const fixture = createFixture([first, second], { ship: first.ship, phase: "source" });
    const firstResult = fixture.send(first);
    await fixture.entered;

    const secondResult = await fixture.send(second);
    expectDelivered(second, secondResult, getUploadedUrl(second));
    const secondRequests = [...second.requests];
    second.controller.abort(second.revoked);
    fixture.resume();

    expectDelivered(first, await firstResult, getUploadedUrl(first));
    expect(second.requests).toEqual(secondRequests);
    expect(first.uploadCanceled).toHaveBeenCalledTimes(1);
    expect(second.uploadCanceled).toHaveBeenCalledTimes(1);
  });
});
