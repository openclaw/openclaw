#!/usr/bin/env node
/**
 * Live repro for the chutes-plugin OAuth bounded-read surface — proves the
 * 16 MiB provider-response cap on `readProviderJsonResponse` for the two
 * active bundled-plugin success-body reads that PR #96249 v1 missed:
 *   - extensions/chutes/oauth.ts fetchChutesUserInfo
 *   - extensions/chutes/oauth.ts exchangeChutesCodeForTokens
 *
 * Run: pnpm exec tsx scripts/repro/issue-chutes-plugin-oauth-bounded-read.mjs
 *
 * Drives the plugin's `loginChutes` end-to-end with a stub fetchFn that
 * returns a hostile 64 MiB streaming body for the success path; the
 * bounded reader must cancel and throw the canonical overflow error
 * before the runtime buffers the full body.
 */
import assert from "node:assert/strict";

const PROVIDER_JSON_RESPONSE_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB
const OVERSIZED_BYTES = 64 * 1024 * 1024;

function overflowingSuccessJsonResponse() {
  let written = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    pull(controller) {
      if (written >= OVERSIZED_BYTES) {
        controller.close();
        return;
      }
      const remaining = OVERSIZED_BYTES - written;
      const slice = Math.min(1024 * 1024, remaining);
      controller.enqueue(encoder.encode("a".repeat(slice)));
      written += slice;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function validTokenExchangeJson() {
  return new Response(
    JSON.stringify({
      access_token: "at_test",
      refresh_token: "rt_test",
      expires_in: 3600,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

async function runPluginLogin(tokenExchangeResponse, userinfoResponse) {
  const { loginChutes } = await import("../../extensions/chutes/oauth.ts");
  return loginChutes({
    app: {
      clientId: "cid_repro",
      redirectUri: "http://127.0.0.1:1456/oauth-callback",
      scopes: ["openid"],
    },
    manual: true,
    createState: () => "state_repro",
    onAuth: async () => {},
    onPrompt: async () => "http://127.0.0.1:1456/oauth-callback?code=code_repro&state=state_repro",
    fetchFn: async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://api.chutes.ai/idp/token") {
        return tokenExchangeResponse;
      }
      if (url === "https://api.chutes.ai/idp/userinfo") {
        return userinfoResponse;
      }
      return new Response("not found", { status: 404 });
    },
  });
}

console.log("=== Reproduction for chutes plugin OAuth bounded JSON response cap ===");
console.log(`PROVIDER_JSON_RESPONSE_MAX_BYTES = ${PROVIDER_JSON_RESPONSE_MAX_BYTES} bytes`);

// 1. Hostile token-exchange success body must be rejected via the bounded reader.
{
  let error = null;
  try {
    await runPluginLogin(overflowingSuccessJsonResponse(), validTokenExchangeJson());
  } catch (err) {
    error = err;
  }
  assert.ok(error, "plugin token exchange must throw on hostile body");
  assert.match(
    error.message,
    /Chutes token exchange/i,
    `error must reference the Chutes token exchange label; got: ${error.message}`,
  );
  assert.match(
    error.message,
    new RegExp(`exceeds ${PROVIDER_JSON_RESPONSE_MAX_BYTES} bytes`),
    `error must surface the canonical overflow text; got: ${error.message}`,
  );
  console.log(`PASS  hostile token exchange body: rejected with "${error.message}"`);
}

// 2. Hostile userinfo success body must be rejected via the bounded reader.
//    (token exchange succeeds, then userinfo overflows before login completes)
{
  let error = null;
  try {
    await runPluginLogin(validTokenExchangeJson(), overflowingSuccessJsonResponse());
  } catch (err) {
    error = err;
  }
  assert.ok(error, "plugin userinfo must throw on hostile body");
  assert.match(
    error.message,
    /Chutes userinfo/i,
    `error must reference the Chutes userinfo label; got: ${error.message}`,
  );
  assert.match(
    error.message,
    new RegExp(`exceeds ${PROVIDER_JSON_RESPONSE_MAX_BYTES} bytes`),
    `error must surface the canonical overflow text; got: ${error.message}`,
  );
  console.log(`PASS  hostile userinfo body: rejected with "${error.message}"`);
}

// 3. Negative control: raw response.json() on the same 64 MiB body must NOT
//    surface the bounded-reader error (proves the swap is meaningful, not inert).
{
  let error = null;
  const hostile = overflowingSuccessJsonResponse();
  try {
    await hostile.json();
  } catch (err) {
    error = err;
  }
  assert.ok(error, "raw json() must throw on 64 MiB non-JSON body");
  assert.doesNotMatch(
    error.message,
    new RegExp(`exceeds ${PROVIDER_JSON_RESPONSE_MAX_BYTES} bytes`),
    "raw json() must NOT surface the bounded-reader wrapping",
  );
  console.log(
    `PASS  negative control: raw response.json() failed with "${error.constructor.name}" (no bounded-reader wrapping)`,
  );
}

console.log("=== All chutes plugin OAuth repro assertions passed ===");
