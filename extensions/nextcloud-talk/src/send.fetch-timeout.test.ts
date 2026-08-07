import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendMessageNextcloudTalk, sendReactionNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";

const REQUEST_TIMEOUT_MS = 50;

function createTalkConfig(baseUrl: string): CoreConfig {
  return {
    channels: {
      "nextcloud-talk": {
        baseUrl,
        botSecret: "test-secret",
        network: { dangerouslyAllowPrivateNetwork: true },
      },
    },
  };
}

async function expectHangingTalkRequestTimesOut(params: {
  path: string;
  run: (baseUrl: string) => Promise<unknown>;
}): Promise<void> {
  let received = false;
  await withServer(
    (request) => {
      received = true;
      expect(request.method).toBe("POST");
      expect(request.url).toBe(params.path);
      request.resume();
    },
    async (baseUrl) => {
      let thrown: unknown;
      try {
        await params.run(baseUrl);
      } catch (error) {
        thrown = error;
      }

      expect(received).toBe(true);
      if (!(thrown instanceof Error)) {
        throw new Error(`expected request timeout, received ${String(thrown)}`);
      }
      expect(["AbortError", "TimeoutError"]).toContain(thrown.name);
    },
  );
}

describe("nextcloud-talk send error responses", () => {
  it("keeps send error body snippets UTF-16 safe", async () => {
    const prefix = "e".repeat(199);
    const errorBody = `${prefix}\u{1F600}tail`;

    await withServer(
      (request, response) => {
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/ocs/v2.php/apps/spreed/api/v1/bot/abc123/message");
        request.resume();
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end(errorBody);
      },
      async (baseUrl) => {
        await expect(
          sendMessageNextcloudTalk("room:abc123", "hello", {
            cfg: createTalkConfig(baseUrl),
            timeoutMs: REQUEST_TIMEOUT_MS,
          }),
        ).rejects.toThrow(new Error(`Nextcloud Talk: bad request - ${prefix}…`));
      },
    );
  });

  it("omits send error body snippet when body exceeds 8 KiB limit", async () => {
    // A body larger than the 8 KiB (8192) cap triggers the truncated path,
    // which must suppress the snippet so no boundary-straddling secret prefix leaks.
    const body = "X".repeat(8300);

    await withServer(
      (request, response) => {
        expect(request.url).toBe("/ocs/v2.php/apps/spreed/api/v1/bot/abc123/message");
        request.resume();
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end(body);
      },
      async (baseUrl) => {
        await expect(
          sendMessageNextcloudTalk("room:abc123", "hello", {
            cfg: createTalkConfig(baseUrl),
            timeoutMs: REQUEST_TIMEOUT_MS,
          }),
        ).rejects.toThrow("Nextcloud Talk: bad request - invalid message format");
      },
    );
  });

  it("redacts reflected HMAC signature from short send error bodies", async () => {
    // A body under 8 KiB that echoes the X-Nextcloud-Talk-Bot-Signature
    // header must have the signature hex replaced with [redacted].
    await withServer(
      (request, response) => {
        const sig = String(request.headers["x-nextcloud-talk-bot-signature"] ?? "");
        expect(request.url).toBe("/ocs/v2.php/apps/spreed/api/v1/bot/abc123/message");
        request.resume();
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end(`error: ${sig} is not valid`);
      },
      async (baseUrl) => {
        await expect(
          sendMessageNextcloudTalk("room:abc123", "hello", {
            cfg: createTalkConfig(baseUrl),
            timeoutMs: REQUEST_TIMEOUT_MS,
          }),
        ).rejects.toThrow(/\[redacted\]/);
      },
    );
  });

  it("omits reaction error body snippet when body exceeds 8 KiB limit", async () => {
    const body = "Y".repeat(8300);

    await withServer(
      (request, response) => {
        expect(request.url).toBe("/ocs/v2.php/apps/spreed/api/v1/bot/abc123/reaction/m-1");
        request.resume();
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end(body);
      },
      async (baseUrl) => {
        await expect(
          sendReactionNextcloudTalk("room:abc123", "m-1", "👍", {
            cfg: createTalkConfig(baseUrl),
            timeoutMs: REQUEST_TIMEOUT_MS,
          }),
        ).rejects.toThrow("Nextcloud Talk reaction failed: 400");
      },
    );
  });

  it("redacts reflected HMAC signature from short reaction error bodies", async () => {
    await withServer(
      (request, response) => {
        const sig = String(request.headers["x-nextcloud-talk-bot-signature"] ?? "");
        expect(request.url).toBe("/ocs/v2.php/apps/spreed/api/v1/bot/abc123/reaction/m-1");
        request.resume();
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end(`error: ${sig} is not valid`);
      },
      async (baseUrl) => {
        await expect(
          sendReactionNextcloudTalk("room:abc123", "m-1", "👍", {
            cfg: createTalkConfig(baseUrl),
            timeoutMs: REQUEST_TIMEOUT_MS,
          }),
        ).rejects.toThrow(/\[redacted\]/);
      },
    );
  });
});

async function expectHeadersThenStallTimesOut(params: {
  path: string;
  run: (baseUrl: string) => Promise<unknown>;
  expectedMessage: string | RegExp;
}): Promise<void> {
  let received = false;
  await withServer(
    (request, response) => {
      received = true;
      expect(request.method).toBe("POST");
      expect(request.url).toBe(params.path);
      request.resume();
      // Send headers (4xx) then hold the body open indefinitely. flushHeaders
      // ensures the status line reaches the client so the test exercises the
      // error-body idle timeout, not the outer request timeout.
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.flushHeaders();
    },
    async (baseUrl) => {
      let thrown: unknown;
      try {
        await params.run(baseUrl);
      } catch (error) {
        thrown = error;
      }

      expect(received).toBe(true);
      if (!(thrown instanceof Error)) {
        throw new Error(`expected request timeout, received ${String(thrown)}`);
      }
      // The error-body idle timeout fires before the outer request timeout,
      // so the snippet is suppressed and the caller falls back to a generic
      // status-only error message.
      expect(thrown.message).toMatch(params.expectedMessage);
    },
  );
}

describe("nextcloud-talk send fetch timeouts", () => {
  it("bounds hanging message and reaction sends", async () => {
    await expectHangingTalkRequestTimesOut({
      path: "/ocs/v2.php/apps/spreed/api/v1/bot/abc123/message",
      run: async (baseUrl) =>
        sendMessageNextcloudTalk("room:abc123", "hello", {
          cfg: createTalkConfig(baseUrl),
          timeoutMs: REQUEST_TIMEOUT_MS,
        }),
    });
    await expectHangingTalkRequestTimesOut({
      path: "/ocs/v2.php/apps/spreed/api/v1/bot/abc123/reaction/m-1",
      run: async (baseUrl) =>
        sendReactionNextcloudTalk("room:abc123", "m-1", "ok", {
          cfg: createTalkConfig(baseUrl),
          timeoutMs: REQUEST_TIMEOUT_MS,
        }),
    });
  });

  describe("with a short error-body idle timeout", () => {
    const IDLE_TIMEOUT_ENV = "OPENCLAW_TEST_NEXTCLOUD_TALK_ERROR_IDLE_TIMEOUT_MS";
    const previousIdleTimeout = process.env[IDLE_TIMEOUT_ENV];

    beforeAll(() => {
      process.env[IDLE_TIMEOUT_ENV] = "50";
    });

    afterAll(() => {
      if (previousIdleTimeout === undefined) {
        delete process.env[IDLE_TIMEOUT_ENV];
      } else {
        process.env[IDLE_TIMEOUT_ENV] = previousIdleTimeout;
      }
    });

    it("bounds message sends where a 4xx response header is followed by a stalled body", async () => {
      await expectHeadersThenStallTimesOut({
        path: "/ocs/v2.php/apps/spreed/api/v1/bot/abc123/message",
        run: async (baseUrl) =>
          sendMessageNextcloudTalk("room:abc123", "hello", {
            cfg: createTalkConfig(baseUrl),
            timeoutMs: 500,
          }),
        expectedMessage: "Nextcloud Talk: bad request - invalid message format",
      });
    });

    it("bounds reaction sends where a 4xx response header is followed by a stalled body", async () => {
      await expectHeadersThenStallTimesOut({
        path: "/ocs/v2.php/apps/spreed/api/v1/bot/abc123/reaction/m-1",
        run: async (baseUrl) =>
          sendReactionNextcloudTalk("room:abc123", "m-1", "ok", {
            cfg: createTalkConfig(baseUrl),
            timeoutMs: 500,
          }),
        expectedMessage: "Nextcloud Talk reaction failed: 400",
      });
    });
  });
});
