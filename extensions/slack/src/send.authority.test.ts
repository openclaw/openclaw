// Slack authority tests exercise the real WebClient queue/retry boundary.
import { WebClient, type WebClientOptions } from "@slack/web-api";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { createSlackSendTestClient } from "./blocks.test-helpers.js";
import { bindSlackWriteClientToAttempt, createSlackWriteClient } from "./client.js";
import type { SlackSendResult } from "./send.js";

const { sendMessageSlack } = await import("./send.js");

const SLACK_TEST_CFG = { channels: { slack: { botToken: "xoxb-test" } } };

function slackSuccess(messageId: string): Response {
  return new Response(JSON.stringify({ ok: true, ts: messageId, channel: "C123" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sendWithClient(
  client: ReturnType<typeof createSlackWriteClient>,
  message: string,
  overrides: Partial<Parameters<typeof sendMessageSlack>[2]> = {},
  target = "channel:C123",
) {
  return sendMessageSlack(target, message, {
    token: "xoxb-test",
    cfg: SLACK_TEST_CFG,
    client,
    ...overrides,
  });
}

type SlackSdkRequestQueue = {
  add<T>(request: () => Promise<T>): Promise<T>;
};

type SlackSdkWebClient = {
  requestQueue: SlackSdkRequestQueue;
};

type SlackSdkWebClientPrototype = {
  makeRequest(
    this: WebClient,
    url: URL,
    body: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<unknown>;
};

function observeSlackSdkAdmissions(
  admissions: ReadonlyMap<string, ReturnType<typeof createDeferred<void>>>,
) {
  const prototype = WebClient.prototype as unknown as SlackSdkWebClientPrototype;
  // oxlint-disable-next-line typescript/unbound-method -- The original prototype method is deliberately invoked later with its WebClient receiver via .call(this, ...).
  const makeRequest = prototype.makeRequest;
  return vi
    .spyOn(prototype, "makeRequest")
    .mockImplementation(function (this: WebClient, url, body, headers) {
      const reached = typeof body.text === "string" ? admissions.get(body.text) : undefined;
      if (reached) {
        const queue = (this as unknown as SlackSdkWebClient).requestQueue;
        const add = queue.add.bind(queue);
        queue.add = <T>(request: () => Promise<T>) => {
          const pending = add(request);
          reached.resolve();
          return pending;
        };
      }
      return makeRequest.call(this, url, body, headers);
    });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Slack physical write authority", () => {
  it("revokes B only after its real SDK request reaches shared admission", async () => {
    const firstAttempt = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    const secondSdkAdmission = createDeferred<void>();
    let active = 0;
    let maximumActive = 0;
    let attempts = 0;
    observeSlackSdkAdmissions(new Map([["second", secondSdkAdmission]]));
    const client = createSlackWriteClient("xoxb-test", {
      maxRequestConcurrency: 1,
      fetch: async () => {
        attempts += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (attempts === 1) {
          firstAttempt.resolve();
          await releaseFirst.promise;
        }
        active -= 1;
        return slackSuccess(`m${attempts}`);
      },
    });
    let secondAuthorityActive = true;
    const first = sendWithClient(
      client,
      "first",
      { assertDirectAdapterHandoff: () => undefined },
      "channel:C123",
    );
    await firstAttempt.promise;
    const second = sendWithClient(
      client,
      "second",
      {
        assertDirectAdapterHandoff: () => {
          if (!secondAuthorityActive) {
            throw new TypeError("queued B authority is no longer active");
          }
        },
      },
      "channel:C456",
    );
    await secondSdkAdmission.promise;

    expect(attempts).toBe(1);
    secondAuthorityActive = false;
    releaseFirst.resolve();

    await expect(first).resolves.toMatchObject({ messageId: "m1" });
    await expect(second).rejects.toThrow("queued B authority is no longer active");
    expect(maximumActive).toBe(1);
    expect(attempts).toBe(1);
  });

  it("keeps valid B queued when the preceding admitted authority is revoked", async () => {
    const blockerAttempt = createDeferred<void>();
    const releaseBlocker = createDeferred<void>();
    const revokedSdkAdmission = createDeferred<void>();
    const validSdkAdmission = createDeferred<void>();
    let attempts = 0;
    observeSlackSdkAdmissions(
      new Map([
        ["revoked", revokedSdkAdmission],
        ["valid", validSdkAdmission],
      ]),
    );
    const client = createSlackWriteClient("xoxb-test", {
      maxRequestConcurrency: 1,
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) {
          blockerAttempt.resolve();
          await releaseBlocker.promise;
        }
        return slackSuccess(`m${attempts}`);
      },
    });
    const revokedController = new AbortController();
    const blocker = sendWithClient(
      client,
      "blocker",
      { assertDirectAdapterHandoff: () => undefined },
      "channel:C123",
    );
    await blockerAttempt.promise;
    const revoked = sendWithClient(
      client,
      "revoked",
      { signal: revokedController.signal },
      "channel:C456",
    );
    await revokedSdkAdmission.promise;
    const valid = sendWithClient(
      client,
      "valid",
      { assertDirectAdapterHandoff: () => undefined },
      "channel:C789",
    );
    await validSdkAdmission.promise;

    expect(attempts).toBe(1);
    revokedController.abort();
    releaseBlocker.resolve();

    await expect(blocker).resolves.toMatchObject({ messageId: "m1" });
    await expect(revoked).rejects.toThrow("This operation was aborted");
    await expect(valid).resolves.toMatchObject({ messageId: "m2" });
    expect(attempts).toBe(2);
  });

  it("copies mutable caller authority into the canonical binding", async () => {
    const firstAuthority = vi.fn();
    const replacementAuthority = vi.fn(() => {
      throw new TypeError("mutable replacement must not run");
    });
    const mutableAuthority: { assertAuthorized?: () => void } = {
      assertAuthorized: firstAuthority,
    };
    const source = createSlackWriteClient("xoxb-test", {
      fetch: async () => slackSuccess("m1"),
    });
    const binding = bindSlackWriteClientToAttempt(source, mutableAuthority);
    mutableAuthority.assertAuthorized = replacementAuthority;

    await expect(
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Slack Web API accepts one options object, not Window.postMessage arguments.
      binding.client.chat.postMessage({ channel: "C123", text: "bound" }),
    ).resolves.toMatchObject({ ts: "m1" });
    expect(Object.isFrozen(binding.authority)).toBe(true);
    expect(firstAuthority).toHaveBeenCalledOnce();
    expect(replacementAuthority).not.toHaveBeenCalled();
  });

  it("rejects an unregistered injected client before any write", async () => {
    const client = createSlackSendTestClient();

    await expect(
      sendWithClient(client as ReturnType<typeof createSlackWriteClient>, "unregistered", {
        assertDirectAdapterHandoff: () => undefined,
      }),
    ).rejects.toThrow("registered write-client factory");
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("keeps the original write client as the reusable DM cache owner", async () => {
    let postCount = 0;
    let openCount = 0;
    const client = createSlackWriteClient("xoxb-test", {
      fetch: async (input) => {
        if (String(input).endsWith("/conversations.open")) {
          openCount += 1;
          return new Response(JSON.stringify({ ok: true, channel: { id: "D123" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        postCount += 1;
        return slackSuccess(`m${postCount}`);
      },
    });

    await expect(
      sendWithClient(
        client,
        "first",
        {
          assertDirectAdapterHandoff: () => undefined,
          deliveryQueueId: "dm-first",
        },
        "user:U12345678",
      ),
    ).resolves.toMatchObject({ messageId: "m1", channelId: "C123" });
    await expect(
      sendWithClient(
        client,
        "second",
        {
          assertDirectAdapterHandoff: () => undefined,
          deliveryQueueId: "dm-second",
        },
        "user:U12345678",
      ),
    ).resolves.toMatchObject({ messageId: "m2", channelId: "C123" });

    expect(openCount).toBe(1);
    expect(postCount).toBe(2);
  });

  it("keeps queued B bound to B authority while A signal stays live", async () => {
    const firstAttempt = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    const requests: string[] = [];
    const client = createSlackWriteClient("xoxb-test", {
      fetch: async (_input, init) => {
        const body = init?.body;
        assert(typeof body === "string", "Expected URL-encoded Slack request body");
        requests.push(body);
        firstAttempt.resolve();
        if (requests.length === 1) {
          await releaseFirst.promise;
        }
        return slackSuccess(`m${requests.length}`);
      },
    });
    const firstController = new AbortController();
    let secondAuthorityActive = true;
    const first = sendWithClient(client, "first", {
      signal: firstController.signal,
    });
    await firstAttempt.promise;
    const second = sendWithClient(client, "second", {
      assertDirectAdapterHandoff: () => {
        if (!secondAuthorityActive) {
          throw new TypeError("second send authority is no longer active");
        }
      },
    });
    secondAuthorityActive = false;
    releaseFirst.resolve();

    await expect(first).resolves.toMatchObject({ messageId: "m1" });
    await expect(second).rejects.toThrow("second send authority is no longer active");
    expect(requests).toHaveLength(1);
  });

  it("keeps queued B live when A signal is revoked before queue admission", async () => {
    const firstAttempt = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    const requests: string[] = [];
    const client = createSlackWriteClient("xoxb-test", {
      fetch: async (_input, init) => {
        const body = init?.body;
        assert(typeof body === "string", "Expected URL-encoded Slack request body");
        requests.push(body);
        firstAttempt.resolve();
        if (requests.length === 1) {
          await releaseFirst.promise;
        }
        return slackSuccess(`m${requests.length}`);
      },
    });
    const blocker = sendWithClient(client, "blocker");
    await firstAttempt.promise;
    const firstController = new AbortController();
    const first = sendWithClient(client, "first", { signal: firstController.signal });
    const second = sendWithClient(client, "second", {
      assertDirectAdapterHandoff: () => undefined,
    });
    firstController.abort();
    releaseFirst.resolve();

    await expect(blocker).resolves.toMatchObject({ messageId: "m1" });
    await expect(first).rejects.toThrow("This operation was aborted");
    await expect(second).resolves.toMatchObject({ messageId: "m2" });
    expect(requests).toHaveLength(2);
  });

  it("rechecks authority before an explicit HTTP 429 retry", async () => {
    let authorityActive = true;
    let attempts = 0;
    const fetch: NonNullable<WebClientOptions["fetch"]> = async () => {
      attempts += 1;
      authorityActive = false;
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0" },
      });
    };
    const client = createSlackWriteClient("xoxb-test", { fetch });

    await expect(
      sendWithClient(client, "retry", {
        assertDirectAdapterHandoff: () => {
          if (!authorityActive) {
            throw new TypeError("retry authority is no longer active");
          }
        },
      }),
    ).rejects.toThrow("retry authority is no longer active");
    expect(attempts).toBe(1);
  });

  it("aborts before a rate-limited write can retry", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const client = createSlackWriteClient("xoxb-test", {
      fetch: async () => {
        attempts += 1;
        controller.abort();
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      },
    });

    await expect(
      sendWithClient(client, "cancelled retry", { signal: controller.signal }),
    ).rejects.toThrow("This operation was aborted");
    expect(attempts).toBe(1);
  });

  it("installs physical fencing when the caller rejects rate limits directly", async () => {
    let attempts = 0;
    const assertAuthorized = vi.fn();
    const client = createSlackWriteClient(
      "xoxb-test",
      {
        rejectRateLimitedCalls: true,
        fetch: async () => {
          attempts += 1;
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "0" },
          });
        },
      },
      { assertAuthorized },
    );

    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Slack Web API accepts one options object, not Window.postMessage arguments.
    await expect(client.chat.postMessage({ channel: "C123", text: "no replay" })).rejects.toThrow();
    expect(assertAuthorized).toHaveBeenCalledOnce();
    expect(attempts).toBe(1);
  });

  it("fences physical SDK retries without changing a nonzero retry budget", async () => {
    let authorityActive = true;
    let authorityChecks = 0;
    let attempts = 0;
    const client = createSlackWriteClient(
      "xoxb-test",
      {
        retryConfig: {
          retries: 2,
          factor: 1,
          minTimeout: 0,
          maxTimeout: 0,
          randomize: false,
        },
        fetch: async () => {
          attempts += 1;
          authorityActive = false;
          throw new TypeError("synthetic network failure");
        },
      },
      {
        assertAuthorized: () => {
          authorityChecks += 1;
          if (!authorityActive) {
            throw new TypeError("sdk retry authority is no longer active");
          }
        },
      },
    );

    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Slack Web API accepts one options object, not Window.postMessage arguments.
    await expect(client.chat.postMessage({ channel: "C123", text: "sdk retry" })).rejects.toThrow(
      "sdk retry authority is no longer active",
    );
    expect(authorityChecks).toBe(3);
    expect(attempts).toBe(1);
  });

  it("preserves accepted evidence while fencing a later chunk", async () => {
    let attempts = 0;
    const client = createSlackWriteClient("xoxb-test", {
      fetch: async () => {
        attempts += 1;
        return slackSuccess(`m${attempts}`);
      },
    });
    let authorityActive = true;
    const acceptedResults: SlackSendResult[] = [];
    const accepted = vi.fn(async (result: SlackSendResult) => {
      acceptedResults.push(result);
      authorityActive = false;
    });

    await expect(
      sendMessageSlack("channel:C123", "a".repeat(8500), {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        assertDirectAdapterHandoff: () => {
          if (!authorityActive) {
            throw new TypeError("later chunk authority is no longer active");
          }
        },
        onDeliveryResult: accepted,
      }),
    ).rejects.toThrow("later chunk authority is no longer active");

    expect(attempts).toBe(1);
    expect(acceptedResults.map((result) => result.messageId)).toEqual(["m1"]);
  });

  it("rechecks authority before a custom-identity fallback post", async () => {
    let attempts = 0;
    let authorityActive = true;
    const client = createSlackWriteClient("xoxb-test", {
      fetch: async () => {
        attempts += 1;
        authorityActive = false;
        return new Response(
          JSON.stringify({
            ok: false,
            error: "missing_scope",
            needed: "chat:write.customize",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });

    await expect(
      sendMessageSlack("channel:C123", "fallback", {
        token: "xoxb-test",
        cfg: SLACK_TEST_CFG,
        client,
        identity: { username: "OpenClaw" },
        assertDirectAdapterHandoff: () => {
          if (!authorityActive) {
            throw new TypeError("fallback authority is no longer active");
          }
        },
      }),
    ).rejects.toThrow("fallback authority is no longer active");

    expect(attempts).toBe(1);
  });
});
