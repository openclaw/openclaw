import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
const TO = `channel:${CHANNEL_ID}`;

function sendOptions(baseUrl: string): Parameters<typeof sendMessageMattermost>[2] {
  setMattermostRuntime(createPluginRuntimeMock());
  return {
    cfg: {
      channels: {
        mattermost: {
          baseUrl,
          botToken: "synthetic-send-authority",
          network: { dangerouslyAllowPrivateNetwork: true },
        },
      },
    },
  };
}

function observeSend(pending: ReturnType<typeof sendMessageMattermost>) {
  return pending.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
}

async function waitForBoundary(
  entered: Promise<void>,
  settled: ReturnType<typeof observeSend>,
): Promise<void> {
  await Promise.race([
    entered,
    settled.then(() => {
      throw new Error("Mattermost send settled before the held boundary");
    }),
  ]);
}

describe("Mattermost send authority lifecycle", () => {
  it("stops DM backoff after retirement even when its cause looks retryable", async () => {
    const requests: string[] = [];
    const retirement = new Error("Mattermost sender aborted");
    retirement.name = "AbortError";
    let current = true;
    const retryLog = vi.fn();

    await withServer(
      (request, response) => {
        request.resume();
        request.on("end", () => {
          const requestPath = request.url ?? "";
          requests.push(requestPath);
          const isDm = requestPath === "/api/v4/channels/direct";
          if (isDm) {
            current = false;
          }
          response.writeHead(isDm ? 503 : 200, { "content-type": "application/json" });
          response.end(
            JSON.stringify(
              isDm
                ? { message: "Temporary DM preparation failure" }
                : { id: "cccccccccccccccccccccccccc" },
            ),
          );
        });
      },
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
            assertDirectAdapterHandoff: () => {
              if (!current) {
                throw retirement;
              }
            },
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

  it("checks the operation fence before invoking a custom transport", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: "bot" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const retirement = new Error("Mattermost sender retired");
    let current = true;
    const client = createMattermostClient({
      baseUrl: "http://localhost:8065",
      botToken: "synthetic-custom-transport",
      fetchImpl,
      assertRequestCurrent: () => {
        if (!current) {
          throw retirement;
        }
      },
    });

    await expect(client.request("/users/me")).resolves.toEqual({ id: "bot" });
    current = false;
    await expect(
      createMattermostPost(client, { channelId: "channel", message: "retired send" }),
    ).rejects.toMatchObject({
      constructor: PlatformMessageNotDispatchedError,
      retryable: false,
      cause: retirement,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]).not.toHaveProperty("isMessagePost");
  });

  it.each([false, true])(
    "rechecks the sender after the dispatch callback settles (reject=%s)",
    async (reject) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const retirement = new Error("Mattermost sender retired during dispatch recording");
      let current = true;
      const requests: string[] = [];
      const onDeliveryResult = vi.fn();
      const onPlatformSendDispatch = vi.fn(async () => {
        entered.resolve();
        await release.promise;
        if (reject) {
          throw new Error("Dispatch recording failed");
        }
      });

      await withServer(
        (request, response) => {
          requests.push(request.url ?? "");
          request.resume();
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: "post-unexpected", channel_id: CHANNEL_ID }));
        },
        async (baseUrl) => {
          const settled = observeSend(
            sendMessageMattermost(TO, "dispatch boundary", {
              ...sendOptions(baseUrl),
              assertDirectAdapterHandoff: () => {
                if (!current) {
                  throw retirement;
                }
              },
              onPlatformSendDispatch,
              onDeliveryResult,
            }),
          );
          try {
            await waitForBoundary(entered.promise, settled);
            current = false;
            release.resolve();
            const outcome = await settled;
            expect(requests).toEqual([]);
            expect(outcome.error).toBeInstanceOf(PlatformMessageNotDispatchedError);
            expect(outcome.error).toMatchObject({ retryable: false, cause: retirement });
            expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
            expect(onDeliveryResult).not.toHaveBeenCalled();
          } finally {
            release.resolve();
          }
        },
      );
    },
  );

  it("preserves a post receipt when the sender retires while its accepted body is pending", async () => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const requests: string[] = [];
    let current = true;
    const onDeliveryResult = vi.fn();
    const onPlatformSendDispatch = vi.fn();

    await withServer(
      (request, response) => {
        request.resume();
        request.on("end", () => {
          requests.push(request.url ?? "");
          response.writeHead(201, { "content-type": "application/json" });
          response.flushHeaders();
          entered.resolve();
          void release.promise.then(() => {
            response.end(JSON.stringify({ id: "post-accepted", channel_id: CHANNEL_ID }));
          });
        });
      },
      async (baseUrl) => {
        const settled = observeSend(
          sendMessageMattermost(TO, "accepted post", {
            ...sendOptions(baseUrl),
            assertDirectAdapterHandoff: () => {
              if (!current) {
                throw new Error("Mattermost sender retired after acceptance");
              }
            },
            onPlatformSendDispatch,
            onDeliveryResult,
          }),
        );
        try {
          await waitForBoundary(entered.promise, settled);
          current = false;
          release.resolve();
          const outcome = await settled;
          expect(outcome.error).toBeUndefined();
          expect(outcome.value?.receipt.platformMessageIds).toEqual(["post-accepted"]);
          expect(requests).toEqual(["/api/v4/posts"]);
          expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
          expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(outcome.value);
        } finally {
          release.resolve();
        }
      },
    );
  });

  it("keeps another send's accepted post separate from a retired send's preparation", async () => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const requests: string[] = [];
    let firstCurrent = true;
    const firstDispatch = vi.fn();
    const firstResult = vi.fn();
    const secondResult = vi.fn();

    await withServer(
      (request, response) => {
        request.resume();
        request.on("end", () => {
          const path = request.url ?? "";
          requests.push(path);
          response.writeHead(200, { "content-type": "application/json" });
          if (path === "/api/v4/users/username/alice") {
            entered.resolve();
            void release.promise.then(() => {
              response.end(JSON.stringify({ id: "bbbbbbbbbbbbbbbbbbbbbbbbbb" }));
            });
          } else {
            response.end(JSON.stringify({ id: "post-second", channel_id: CHANNEL_ID }));
          }
        });
      },
      async (baseUrl) => {
        const options = sendOptions(baseUrl);
        const first = observeSend(
          sendMessageMattermost("@alice", "first operation", {
            ...options,
            assertDirectAdapterHandoff: () => {
              if (!firstCurrent) {
                throw new Error("First Mattermost sender retired");
              }
            },
            onPlatformSendDispatch: firstDispatch,
            onDeliveryResult: firstResult,
          }),
        );
        try {
          await waitForBoundary(entered.promise, first);
          const second = await sendMessageMattermost(TO, "second operation", {
            ...options,
            assertDirectAdapterHandoff: () => {},
            onDeliveryResult: secondResult,
          });
          firstCurrent = false;
          release.resolve();
          const outcome = await first;
          expect(outcome.error).toBeInstanceOf(PlatformMessageNotDispatchedError);
          expect(outcome.error).toMatchObject({ retryable: false });
          expect(firstDispatch).not.toHaveBeenCalled();
          expect(firstResult).not.toHaveBeenCalled();
          expect(second.receipt.platformMessageIds).toEqual(["post-second"]);
          expect(secondResult).toHaveBeenCalledExactlyOnceWith(second);
          expect(requests).toEqual(["/api/v4/users/username/alice", "/api/v4/posts"]);
        } finally {
          release.resolve();
        }
      },
    );
  });
});

describe("Mattermost media limits at the upload boundary", () => {
  it("rejects oversized source bytes without uploading or falling back to a text post", async () => {
    const directory = await realpath(await mkdtemp(nodePath.join(os.tmpdir(), "mattermost-cap-")));
    const file = nodePath.join(directory, "attachment.txt");
    const writes: string[] = [];
    setMattermostRuntime(createPluginRuntimeMock());
    try {
      await withServer(
        (request, response) => {
          request.resume();
          request.on("end", () => {
            writes.push(request.url ?? "");
            response.writeHead(201, { "content-type": "application/json" });
            response.end(
              JSON.stringify(
                request.url === "/api/v4/files"
                  ? { file_infos: [{ id: "file-cap" }] }
                  : { id: "post-cap", channel_id: "aaaaaaaaaaaaaaaaaaaaaaaaaa" },
              ),
            );
          });
        },
        async (baseUrl) => {
          const opts = {
            cfg: {
              channels: {
                mattermost: {
                  baseUrl,
                  botToken: "fixture",
                  mediaMaxMb: 10,
                  network: { dangerouslyAllowPrivateNetwork: true },
                  accounts: { Limited: { mediaMaxMb: 1 / 1024 } },
                },
              },
            },
            accountId: "limited",
            mediaUrl: file,
            mediaLocalRoots: [directory],
          };
          await writeFile(file, "x".repeat(1536));
          await expect(
            sendMessageMattermost("channel:aaaaaaaaaaaaaaaaaaaaaaaaaa", "caption", opts),
          ).rejects.toThrow(/exceeds.*limit/i);
          expect(writes).toEqual([]);
          await writeFile(file, "x".repeat(512));
          const result = await sendMessageMattermost(
            "channel:aaaaaaaaaaaaaaaaaaaaaaaaaa",
            "caption",
            opts,
          );
          expect(result.messageId).toBe("post-cap");
          expect(writes).toEqual(["/api/v4/files", "/api/v4/posts"]);
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const USER_ID = "abcdefghijklmnopqrstuvwxyz";
const BOT_ID = "bcdefghijklmnopqrstuvwxyza";
const LOOPBACK_CHANNEL_ID = "cdefghijklmnopqrstuvwxyzab";

describe("Mattermost send target policy over real HTTP", () => {
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
          const requestPath = request.url ?? "";
          requests.push({ path: requestPath, body, authorization: request.headers.authorization });
          response.setHeader("content-type", "application/json");
          if (requestPath === `/api/v4/users/${USER_ID}`) {
            response.end(JSON.stringify({ id: USER_ID }));
          } else if (requestPath === "/api/v4/users/me") {
            response.end(JSON.stringify({ id: BOT_ID }));
          } else if (requestPath === "/api/v4/channels/direct") {
            response.end(JSON.stringify({ id: LOOPBACK_CHANNEL_ID, type: "D" }));
          } else if (requestPath === "/api/v4/posts" && body?.channel_id === LOOPBACK_CHANNEL_ID) {
            response.end(JSON.stringify({ id: "post-1", message: body.message }));
          } else {
            response.writeHead(400);
            response.end(JSON.stringify({ message: "Unknown channel" }));
          }
        });
      },
      async (baseUrl) => {
        const cfg = {
          channels: {
            mattermost: {
              accounts: {
                selected: {
                  baseUrl,
                  botToken: "synthetic-selected",
                  network: { dangerouslyAllowPrivateNetwork: true },
                },
                restricted: { baseUrl, botToken: "synthetic-selected" },
              },
            },
          },
        };
        for (const target of [
          USER_ID,
          USER_ID,
          `user:${USER_ID}`,
          `channel:${LOOPBACK_CHANNEL_ID}`,
        ]) {
          const result = await sendMessageMattermost(target, "target proof", {
            cfg,
            accountId: "selected",
          });
          expect(result).toMatchObject({ messageId: "post-1", channelId: LOOPBACK_CHANNEL_ID });
        }
        expect(requests.map(({ path }) => path)).toEqual([
          `/api/v4/users/${USER_ID}`,
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
        for (const target of [
          USER_ID,
          "defghijklmnopqrstuvwxyzabc",
          `user:${USER_ID}`,
          `channel:${LOOPBACK_CHANNEL_ID}`,
        ]) {
          await expect(
            sendMessageMattermost(target, "blocked", { cfg, accountId: "restricted" }),
          ).rejects.toThrow();
        }
        expect(requests).toHaveLength(count);
      },
    );
  });
});
