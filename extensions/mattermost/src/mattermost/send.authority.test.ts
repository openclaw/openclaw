import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import type { RequestListener, ServerResponse } from "node:http";
import os from "node:os";
import nodePath from "node:path";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { setMattermostRuntime } from "../runtime.js";
import { createMattermostClient, createMattermostPost } from "./client.js";
import { sendMessageMattermost } from "./send.js";

const CHANNEL_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const TO = "channel:" + CHANNEL_ID;
type SendOptions = Parameters<typeof sendMessageMattermost>[2];
type AccountConfig = NonNullable<SendOptions["cfg"]["channels"]>["mattermost"];
const config = (mattermost: AccountConfig): SendOptions["cfg"] => ({ channels: { mattermost } });

function sendOptions(baseUrl: string): SendOptions {
  setMattermostRuntime(createPluginRuntimeMock());
  const account = {
    baseUrl,
    botToken: "synthetic-send-authority",
    network: { dangerouslyAllowPrivateNetwork: true },
  };
  return { cfg: config(account) };
}

function json(response: ServerResponse, body: unknown, code = 200) {
  response.writeHead(code, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const afterBody =
  (handler: RequestListener): RequestListener =>
  (request, response) => {
    request.resume();
    request.on("end", () => handler(request, response));
  };

function authority(error = new Error("Mattermost sender retired")) {
  let current = true;
  return {
    error,
    retire: () => {
      current = false;
    },
    assertCurrent: () => {
      if (!current) {
        throw error;
      }
    },
  };
}

function observeSend(pending: ReturnType<typeof sendMessageMattermost>) {
  return pending.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
}

function heldBoundary() {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  return {
    entered,
    release,
    async settle(
      pending: ReturnType<typeof sendMessageMattermost>,
      beforeRelease: () => void | Promise<void>,
    ) {
      const settled = observeSend(pending);
      try {
        await Promise.race([
          entered.promise,
          settled.then(() => {
            throw new Error("Mattermost send settled before the held boundary");
          }),
        ]);
        await beforeRelease();
        release.resolve();
        return await settled;
      } finally {
        release.resolve();
      }
    },
  };
}

describe("Mattermost send authority lifecycle", () => {
  it("stops DM backoff after retirement even when its cause looks retryable", async () => {
    const requests: string[] = [];
    const retirement = new Error("Mattermost sender aborted");
    retirement.name = "AbortError";
    const sender = authority(retirement);
    const retryLog = vi.fn();
    await withServer(
      afterBody((request, response) => {
        const requestPath = request.url ?? "";
        requests.push(requestPath);
        const isDm = requestPath === "/api/v4/channels/direct";
        if (isDm) {
          sender.retire();
        }
        json(
          response,
          isDm
            ? { message: "Temporary DM preparation failure" }
            : { id: "cccccccccccccccccccccccccc" },
          isDm ? 503 : 200,
        );
      }),
      async (baseUrl) => {
        const options = sendOptions(baseUrl);
        const runtime = createPluginRuntimeMock();
        const logger = runtime.logging.getChildLogger({ module: "mattermost" });
        runtime.logging.shouldLogVerbose = () => true;
        runtime.logging.getChildLogger = () => ({ ...logger, warn: retryLog });
        setMattermostRuntime(runtime);
        options.cfg.channels!.mattermost!.dmChannelRetry = {
          maxRetries: 3,
          initialDelayMs: 0,
          maxDelayMs: 0,
        };
        const outcome = await observeSend(
          sendMessageMattermost("user:bbbbbbbbbbbbbbbbbbbbbbbbbb", "retired DM", {
            ...options,
            assertDirectAdapterHandoff: sender.assertCurrent,
          }),
        );
        expect(requests).toEqual(["/api/v4/users/me", "/api/v4/channels/direct"]);
        expect(retryLog).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("DM channel creation retry 1 after 0ms:"),
        );
        expect(outcome.error).toBeInstanceOf(PlatformMessageNotDispatchedError);
        expect(outcome.error).toMatchObject({ retryable: false, cause: retirement });
      },
    );
  });

  it("checks the operation fence before guarded dispatch", async () => {
    const requests: string[] = [];
    const sender = authority();
    await withServer(
      (request, response) => {
        requests.push(request.url ?? "");
        request.resume();
        json(response, { id: "bot" });
      },
      async (baseUrl) => {
        const client = createMattermostClient({
          baseUrl,
          botToken: "synthetic-guarded-transport",
          allowPrivateNetwork: true,
          assertRequestCurrent: sender.assertCurrent,
        });
        await expect(client.request("/users/me")).resolves.toEqual({ id: "bot" });
        sender.retire();
        await expect(
          createMattermostPost(client, { channelId: "channel", message: "retired send" }),
        ).rejects.toMatchObject({
          constructor: PlatformMessageNotDispatchedError,
          retryable: false,
          cause: sender.error,
        });
        expect(requests).toEqual(["/api/v4/users/me"]);
      },
    );
  });

  it.each(["dispatch-resolve", "dispatch-reject", "accepted-body"] as const)(
    "settles retirement at %s without losing an accepted post",
    async (stage) => {
      const accepted = stage === "accepted-body";
      const hold = heldBoundary();
      const sender = authority();
      const requests: string[] = [];
      const onDeliveryResult = vi.fn();
      const onPlatformSendDispatch = vi.fn(async () => {
        if (!accepted) {
          hold.entered.resolve();
          await hold.release.promise;
          if (stage === "dispatch-reject") {
            throw new Error("Dispatch recording failed");
          }
        }
      });
      await withServer(
        afterBody((request, response) => {
          requests.push(request.url ?? "");
          response.writeHead(201, { "content-type": "application/json" });
          if (accepted) {
            response.flushHeaders();
            hold.entered.resolve();
            void hold.release.promise.then(() => {
              response.end(JSON.stringify({ id: "post-accepted", channel_id: CHANNEL_ID }));
            });
          } else {
            response.end(JSON.stringify({ id: "post-unexpected", channel_id: CHANNEL_ID }));
          }
        }),
        async (baseUrl) => {
          const outcome = await hold.settle(
            sendMessageMattermost(TO, "held send", {
              ...sendOptions(baseUrl),
              assertDirectAdapterHandoff: sender.assertCurrent,
              onPlatformSendDispatch,
              onDeliveryResult,
            }),
            sender.retire,
          );
          expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
          if (accepted) {
            expect(outcome.error).toBeUndefined();
            expect(outcome.value?.receipt.platformMessageIds).toEqual(["post-accepted"]);
            expect(requests).toEqual(["/api/v4/posts"]);
            expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(outcome.value);
          } else {
            expect(requests).toEqual([]);
            expect(outcome.error).toBeInstanceOf(PlatformMessageNotDispatchedError);
            expect(outcome.error).toMatchObject({ retryable: false, cause: sender.error });
            expect(onDeliveryResult).not.toHaveBeenCalled();
          }
        },
      );
    },
  );

  it("keeps another send's accepted post separate from a retired send's preparation", async () => {
    const hold = heldBoundary();
    const sender = authority(new Error("First Mattermost sender retired"));
    const requests: string[] = [];
    const firstDispatch = vi.fn();
    const firstResult = vi.fn();
    const secondResult = vi.fn();
    await withServer(
      afterBody((request, response) => {
        const path = request.url ?? "";
        requests.push(path);
        response.writeHead(200, { "content-type": "application/json" });
        if (path === "/api/v4/users/username/alice") {
          hold.entered.resolve();
          void hold.release.promise.then(() => {
            response.end(JSON.stringify({ id: "bbbbbbbbbbbbbbbbbbbbbbbbbb" }));
          });
        } else {
          response.end(JSON.stringify({ id: "post-second", channel_id: CHANNEL_ID }));
        }
      }),
      async (baseUrl) => {
        const options = sendOptions(baseUrl);
        const outcome = await hold.settle(
          sendMessageMattermost("@alice", "first operation", {
            ...options,
            assertDirectAdapterHandoff: sender.assertCurrent,
            onPlatformSendDispatch: firstDispatch,
            onDeliveryResult: firstResult,
          }),
          async () => {
            const second = await sendMessageMattermost(TO, "second operation", {
              ...options,
              assertDirectAdapterHandoff: () => {},
              onDeliveryResult: secondResult,
            });
            sender.retire();
            expect(second.receipt.platformMessageIds).toEqual(["post-second"]);
            expect(secondResult).toHaveBeenCalledExactlyOnceWith(second);
          },
        );
        expect(outcome.error).toBeInstanceOf(PlatformMessageNotDispatchedError);
        expect(outcome.error).toMatchObject({ retryable: false });
        expect(firstDispatch).not.toHaveBeenCalled();
        expect(firstResult).not.toHaveBeenCalled();
        expect(requests).toEqual(["/api/v4/users/username/alice", "/api/v4/posts"]);
      },
    );
  });
});

it("rejects oversized source bytes without uploading or falling back to a text post", async () => {
  const directory = await realpath(await mkdtemp(nodePath.join(os.tmpdir(), "mattermost-cap-")));
  const file = nodePath.join(directory, "attachment.txt");
  const writes: string[] = [];
  setMattermostRuntime(createPluginRuntimeMock());
  try {
    await withServer(
      afterBody((request, response) => {
        writes.push(request.url ?? "");
        json(
          response,
          request.url === "/api/v4/files"
            ? { file_infos: [{ id: "file-cap" }] }
            : { id: "post-cap", channel_id: CHANNEL_ID },
          201,
        );
      }),
      async (baseUrl) => {
        const opts = sendOptions(baseUrl);
        opts.cfg.channels!.mattermost!.mediaMaxMb = 10;
        opts.cfg.channels!.mattermost!.accounts = { Limited: { mediaMaxMb: 1 / 1024 } };
        const mediaOptions = {
          ...opts,
          accountId: "limited",
          mediaUrl: file,
          mediaLocalRoots: [directory],
        };
        await writeFile(file, "x".repeat(1536));
        await expect(sendMessageMattermost(TO, "caption", mediaOptions)).rejects.toThrow(
          /exceeds.*limit/i,
        );
        expect(writes).toEqual([]);
        await writeFile(file, "x".repeat(512));
        expect((await sendMessageMattermost(TO, "caption", mediaOptions)).messageId).toBe(
          "post-cap",
        );
        expect(writes).toEqual(["/api/v4/files", "/api/v4/posts"]);
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const USER_ID = "abcdefghijklmnopqrstuvwxyz";
const BOT_ID = "bcdefghijklmnopqrstuvwxyza";
const LOOPBACK_CHANNEL_ID = "cdefghijklmnopqrstuvwxyzab";
const USER_TARGET = "user:" + USER_ID;
const CHANNEL_TARGET = "channel:" + LOOPBACK_CHANNEL_ID;

it("resolves cold and warm bare users with the selected account policy", async () => {
  setMattermostRuntime(createPluginRuntimeMock());
  const requests: Array<{ path: string; body: unknown; authorization?: string }> = [];
  await withServer(
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        const body = raw
          ? (JSON.parse(raw) as { channel_id?: string; message?: string })
          : undefined;
        const path = request.url ?? "";
        requests.push({ path, body, authorization: request.headers.authorization });
        if (path === "/api/v4/users/" + USER_ID) {
          json(response, { id: USER_ID });
        } else if (path === "/api/v4/users/me") {
          json(response, { id: BOT_ID });
        } else if (path === "/api/v4/channels/direct") {
          json(response, { id: LOOPBACK_CHANNEL_ID, type: "D" });
        } else if (path === "/api/v4/posts" && body?.channel_id === LOOPBACK_CHANNEL_ID) {
          json(response, { id: "post-1", message: body.message });
        } else {
          json(response, { message: "Unknown channel" }, 400);
        }
      });
    },
    async (baseUrl) => {
      const account = { baseUrl, botToken: "synthetic-selected" };
      const cfg = config({
        accounts: {
          selected: { ...account, network: { dangerouslyAllowPrivateNetwork: true } },
          restricted: account,
        },
      });
      for (const target of [USER_ID, USER_ID, USER_TARGET, CHANNEL_TARGET]) {
        const result = await sendMessageMattermost(target, "target proof", {
          cfg,
          accountId: "selected",
        });
        expect(result).toMatchObject({ messageId: "post-1", channelId: LOOPBACK_CHANNEL_ID });
      }
      expect(requests.map(({ path }) => path)).toEqual([
        "/api/v4/users/" + USER_ID,
        "/api/v4/users/me",
        "/api/v4/channels/direct",
        "/api/v4/posts",
        "/api/v4/posts",
        "/api/v4/posts",
        "/api/v4/posts",
      ]);
      expect(requests.find(({ path }) => path === "/api/v4/channels/direct")?.body).toEqual([
        BOT_ID,
        USER_ID,
      ]);
      expect(
        requests.every(({ authorization }) => authorization === "Bearer synthetic-selected"),
      ).toBe(true);
      const count = requests.length;
      for (const target of [USER_ID, "defghijklmnopqrstuvwxyzabc", USER_TARGET, CHANNEL_TARGET]) {
        await expect(
          sendMessageMattermost(target, "blocked", { cfg, accountId: "restricted" }),
        ).rejects.toThrow();
      }
      expect(requests).toHaveLength(count);
    },
  );
});
