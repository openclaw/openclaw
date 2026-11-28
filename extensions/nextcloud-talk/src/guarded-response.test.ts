import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "../runtime-api.js";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { resolveNextcloudTalkRoomKind } from "./room-info.js";
import { sendMessageNextcloudTalk, sendReactionNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";

vi.mock("../runtime-api.js", () => ({ fetchWithSsrFGuard: vi.fn() }));

afterEach(() => {
  vi.mocked(fetchWithSsrFGuard).mockReset();
});

const cfg: CoreConfig = {
  channels: {
    "nextcloud-talk": {
      baseUrl: "https://cloud.example.test",
      botSecret: "fixture-secret",
      apiUser: "fixture-user",
      apiPassword: "fixture-password",
    },
  },
};

describe("Nextcloud Talk guarded response release", () => {
  it.each([
    {
      name: "successful reaction",
      status: 201,
      run: () => sendReactionNextcloudTalk("room:release", "42", "👍", { cfg }),
      expected: undefined,
    },
    {
      name: "failed room lookup",
      status: 404,
      run: () =>
        resolveNextcloudTalkRoomKind({
          account: resolveNextcloudTalkAccount({ cfg }),
          roomToken: "release-regression",
        }),
      expected: undefined,
    },
  ])("returns the $name result without waiting for body cancellation", async (testCase) => {
    const cancellation = createDeferred<void>();
    const response = new Response(
      new ReadableStream<Uint8Array>({ cancel: () => cancellation.promise }),
      { status: testCase.status },
    );
    const release = vi.fn(async () => {});
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response,
      release,
      finalUrl: "https://cloud.example.test",
    });
    const result = testCase.run();
    const waiting = Symbol("waiting for body cancellation");
    try {
      const observed = await Promise.race([
        result,
        new Promise<symbol>((resolve) => {
          setImmediate(() => resolve(waiting));
        }),
      ]);
      expect(observed).toEqual(testCase.expected);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      cancellation.resolve();
      await result;
      await response.body?.cancel();
    }
  });
});

describe("Nextcloud Talk streamed success receipts", () => {
  const streamCfg: CoreConfig = {
    channels: {
      "nextcloud-talk": {
        defaultAccount: "work",
        accounts: { work: { baseUrl: "https://cloud.example.test", botSecret: "fixture-secret" } },
      },
    },
  };

  it.each([
    { name: "over the response cap", paddingChunks: 17, messageId: "unknown", cancelled: true },
    { name: "under the response cap", paddingChunks: 1, messageId: "987654", cancelled: false },
  ])("handles valid streamed JSON $name", async (testCase) => {
    const encoder = new TextEncoder();
    const chunk = encoder.encode("x".repeat(1024 * 1024));
    const cancel = vi.fn();
    let pulls = 0;
    let tailEmitted = false;
    // No prefetch: an over-limit reader must cancel before requesting the valid JSON tail.
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulls === 0) {
            controller.enqueue(
              encoder.encode('{"ocs":{"data":{"id":987654,"timestamp":1706000009}},"padding":"'),
            );
          } else if (pulls <= testCase.paddingChunks) {
            controller.enqueue(chunk);
          } else {
            tailEmitted = true;
            controller.enqueue(encoder.encode('"}'));
            controller.close();
          }
          pulls += 1;
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const response = new Response(stream, { status: 200 });
    const release = vi.fn(async () => {});
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response,
      release,
      finalUrl: "https://cloud.example.test",
    });

    const result = await sendMessageNextcloudTalk("room:receipt", "hello", {
      cfg: streamCfg,
      accountId: "work",
    });

    expect(response.headers.has("content-length")).toBe(false);
    expect(result.messageId).toBe(testCase.messageId);
    expect(result.timestamp).toBe(testCase.cancelled ? undefined : 1706000009);
    expect(result.receipt.platformMessageIds).toEqual(testCase.cancelled ? [] : ["987654"]);
    expect(result.receipt.primaryPlatformMessageId).toBe(testCase.cancelled ? undefined : "987654");
    expect(cancel).toHaveBeenCalledTimes(testCase.cancelled ? 1 : 0);
    expect(tailEmitted).toBe(!testCase.cancelled);
    expect(fetchWithSsrFGuard).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
