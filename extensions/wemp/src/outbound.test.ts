import assert from "node:assert/strict";
import test from "node:test";
import { getAccessToken, recordUserInteraction } from "../src/api.js";
import {
  sendFileByMediaId,
  sendText,
  sendVideoByMediaId,
  sendVoiceByMediaId,
} from "../src/outbound.js";
import type { ResolvedWempAccount } from "../src/types.js";

function accountFixture(accountId: string): ResolvedWempAccount {
  return {
    accountId,
    enabled: true,
    configured: true,
    appId: "app",
    appSecret: "secret",
    token: "token",
    webhookPath: "/wemp",
    dm: { policy: "pairing", allowFrom: [] },
    routing: { pairedAgent: "main", unpairedAgent: "wemp-kf" },
    features: {
      menu: { enabled: false, items: [] },
      assistantToggle: { enabled: false, defaultEnabled: false },
      usageLimit: { enabled: false, dailyMessages: 0, dailyTokens: 0, exemptPaired: true },
      handoff: { enabled: false, contact: "", message: "" },
      welcome: { enabled: false, subscribeText: "" },
    },
    config: {},
  };
}

function openCustomerServiceWindow(account: ResolvedWempAccount, openId: string): void {
  recordUserInteraction(account.accountId, openId);
}

test("outbound serializes concurrent sends for the same target", async (t) => {
  const account = accountFixture(`acc-outbound-serial-${Date.now()}-${Math.random()}`);
  const originalFetch = globalThis.fetch;

  let tokenCalls = 0;
  let sendCalls = 0;
  let inFlightSend = 0;
  let maxInFlightSend = 0;
  let releaseSends = false;

  globalThis.fetch = (async (url: string | URL) => {
    const value = String(url);
    if (value.includes("/cgi-bin/token")) {
      tokenCalls += 1;
      return new Response(
        JSON.stringify({
          access_token: `token-${account.accountId}`,
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (value.includes("/cgi-bin/message/custom/send")) {
      sendCalls += 1;
      inFlightSend += 1;
      maxInFlightSend = Math.max(maxInFlightSend, inFlightSend);
      while (!releaseSends) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      inFlightSend -= 1;
      return new Response(
        JSON.stringify({
          errcode: 0,
          errmsg: "ok",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected url: ${value}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await getAccessToken(account);
  assert.equal(tokenCalls, 1);
  openCustomerServiceWindow(account, "open-id-same-target");

  const first = sendText(account, "open-id-same-target", "msg-1");
  const second = sendText(account, "open-id-same-target", "msg-2");

  await new Promise((resolve) => setTimeout(resolve, 30));
  releaseSends = true;
  await Promise.all([first, second]);

  assert.equal(sendCalls, 2);
  assert.equal(maxInFlightSend, 1);
});

test("outbound retries once and succeeds after token-expired failure", async (t) => {
  const account = accountFixture(`acc-outbound-retry-${Date.now()}-${Math.random()}`);
  const originalFetch = globalThis.fetch;

  let tokenCalls = 0;
  let sendCalls = 0;

  globalThis.fetch = (async (url: string | URL) => {
    const value = String(url);
    if (value.includes("/cgi-bin/token")) {
      tokenCalls += 1;
      return new Response(
        JSON.stringify({
          access_token: `token-${tokenCalls}`,
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (value.includes("/cgi-bin/message/custom/send")) {
      sendCalls += 1;
      if (sendCalls === 1) {
        return new Response(
          JSON.stringify({
            errcode: 40001,
            errmsg: "invalid credential",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          errcode: 0,
          errmsg: "ok",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected url: ${value}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  openCustomerServiceWindow(account, "open-id-retry");
  const result = await sendText(account, "open-id-retry", "hello");

  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.ok, true);
  assert.equal(result.results[0]?.retried, true);
  assert.equal(sendCalls, 2);
  assert.equal(tokenCalls, 2);
});

test("sendVoiceByMediaId sends voice msgtype with media_id", async (t) => {
  const account = accountFixture(`acc-outbound-voice-${Date.now()}-${Math.random()}`);
  const originalFetch = globalThis.fetch;
  const capturedPayloads: Record<string, unknown>[] = [];

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const value = String(url);
    if (value.includes("/cgi-bin/token")) {
      return new Response(
        JSON.stringify({
          access_token: `token-${account.accountId}`,
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (value.includes("/cgi-bin/message/custom/send")) {
      assert.equal(typeof init?.body, "string");
      capturedPayloads.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          errcode: 0,
          errmsg: "ok",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected url: ${value}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  openCustomerServiceWindow(account, "open-id-voice");
  const mediaId = "voice-media-id";
  const result = await sendVoiceByMediaId(account, "open-id-voice", mediaId);

  assert.equal(result.ok, true);
  assert.equal(capturedPayloads.length, 1);
  assert.equal(capturedPayloads[0]?.msgtype, "voice");
  assert.equal(
    (capturedPayloads[0]?.voice as { media_id?: unknown } | undefined)?.media_id,
    mediaId,
  );
});

test("sendVideoByMediaId sends video msgtype with media_id", async (t) => {
  const account = accountFixture(`acc-outbound-video-${Date.now()}-${Math.random()}`);
  const originalFetch = globalThis.fetch;
  const capturedPayloads: Record<string, unknown>[] = [];

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const value = String(url);
    if (value.includes("/cgi-bin/token")) {
      return new Response(
        JSON.stringify({
          access_token: `token-${account.accountId}`,
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (value.includes("/cgi-bin/message/custom/send")) {
      assert.equal(typeof init?.body, "string");
      capturedPayloads.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          errcode: 0,
          errmsg: "ok",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected url: ${value}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  openCustomerServiceWindow(account, "open-id-video");
  const mediaId = "video-media-id";
  const result = await sendVideoByMediaId(account, "open-id-video", mediaId);

  assert.equal(result.ok, true);
  assert.equal(capturedPayloads.length, 1);
  assert.equal(capturedPayloads[0]?.msgtype, "video");
  assert.equal(
    (capturedPayloads[0]?.video as { media_id?: unknown } | undefined)?.media_id,
    mediaId,
  );
});

test("sendFileByMediaId sends file msgtype with media_id", async (t) => {
  const account = accountFixture(`acc-outbound-file-${Date.now()}-${Math.random()}`);
  const originalFetch = globalThis.fetch;
  const capturedPayloads: Record<string, unknown>[] = [];

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const value = String(url);
    if (value.includes("/cgi-bin/token")) {
      return new Response(
        JSON.stringify({
          access_token: `token-${account.accountId}`,
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (value.includes("/cgi-bin/message/custom/send")) {
      assert.equal(typeof init?.body, "string");
      capturedPayloads.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          errcode: 0,
          errmsg: "ok",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected url: ${value}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  openCustomerServiceWindow(account, "open-id-file");
  const mediaId = "file-media-id";
  const result = await sendFileByMediaId(account, "open-id-file", mediaId);

  assert.equal(result.ok, true);
  assert.equal(capturedPayloads.length, 1);
  assert.equal(capturedPayloads[0]?.msgtype, "file");
  assert.equal(
    (capturedPayloads[0]?.file as { media_id?: unknown } | undefined)?.media_id,
    mediaId,
  );
});

test("outbound falls back to legacy outbound.retryCount/retryDelay", async (t) => {
  const account = accountFixture(`acc-outbound-legacy-nested-${Date.now()}-${Math.random()}`);
  account.config = {
    outbound: {
      retryCount: 2,
      retryDelay: 0,
    },
  };
  const originalFetch = globalThis.fetch;
  let sendCalls = 0;

  globalThis.fetch = (async (url: string | URL) => {
    const value = String(url);
    if (value.includes("/cgi-bin/token")) {
      return new Response(
        JSON.stringify({
          access_token: `token-${account.accountId}`,
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (value.includes("/cgi-bin/message/custom/send")) {
      sendCalls += 1;
      if (sendCalls < 3) {
        return new Response(
          JSON.stringify({
            errcode: 45009,
            errmsg: "api_freq_out_of_limit",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          errcode: 0,
          errmsg: "ok",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected url: ${value}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  openCustomerServiceWindow(account, "open-id-legacy-nested");
  const result = await sendText(account, "open-id-legacy-nested", "hello legacy");
  assert.equal(result.ok, true);
  assert.equal(sendCalls, 3);
  assert.equal(result.results[0]?.retried, true);
});

test("outbound prefers canonical retries over legacy retryCount", async (t) => {
  const account = accountFixture(`acc-outbound-priority-${Date.now()}-${Math.random()}`);
  account.config = {
    outbound: {
      retries: 0,
      retryCount: 3,
      retryDelay: 0,
    },
  };
  const originalFetch = globalThis.fetch;
  let sendCalls = 0;

  globalThis.fetch = (async (url: string | URL) => {
    const value = String(url);
    if (value.includes("/cgi-bin/token")) {
      return new Response(
        JSON.stringify({
          access_token: `token-${account.accountId}`,
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (value.includes("/cgi-bin/message/custom/send")) {
      sendCalls += 1;
      return new Response(
        JSON.stringify({
          errcode: 45009,
          errmsg: "api_freq_out_of_limit",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected url: ${value}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  openCustomerServiceWindow(account, "open-id-priority");
  const result = await sendText(account, "open-id-priority", "priority");
  assert.equal(result.ok, false);
  assert.equal(sendCalls, 1);
});

test("outbound falls back to legacy top-level outboundRetryTimes/outboundRetryDelay", async (t) => {
  const account = accountFixture(`acc-outbound-legacy-top-${Date.now()}-${Math.random()}`);
  account.config = {
    outboundRetryTimes: 1,
    outboundRetryDelay: 0,
  };
  const originalFetch = globalThis.fetch;
  let sendCalls = 0;

  globalThis.fetch = (async (url: string | URL) => {
    const value = String(url);
    if (value.includes("/cgi-bin/token")) {
      return new Response(
        JSON.stringify({
          access_token: `token-${account.accountId}`,
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (value.includes("/cgi-bin/message/custom/send")) {
      sendCalls += 1;
      if (sendCalls === 1) {
        return new Response(
          JSON.stringify({
            errcode: 45009,
            errmsg: "api_freq_out_of_limit",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          errcode: 0,
          errmsg: "ok",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected url: ${value}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  openCustomerServiceWindow(account, "open-id-legacy-top");
  const result = await sendText(account, "open-id-legacy-top", "legacy top");
  assert.equal(result.ok, true);
  assert.equal(sendCalls, 2);
  assert.equal(result.results[0]?.retried, true);
});
