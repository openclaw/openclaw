import { createServer } from "node:http";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { ProviderAuthContext, ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";
import { buildApiKeyCredential, type ProviderAuthResult } from "openclaw/plugin-sdk/provider-auth";
import { applyPollinationsConfig, POLLINATIONS_DEFAULT_MODEL_REF } from "./onboard.js";

const PROVIDER_ID = "pollinations";
const POLLINATIONS_AUTH_METHOD_ID = "byop";
export const POLLINATIONS_AUTH_CHOICE_ID = "pollinations-byop";

// Fragment flow (local) constants
const FRAGMENT_CALLBACK_HOST = "localhost";
const FRAGMENT_CALLBACK_PORT = 17456;
const FRAGMENT_CALLBACK_PATH = "/pollinations/callback";
const FRAGMENT_TOKEN_PATH = "/pollinations/token";
const FRAGMENT_REDIRECT_URI = `http://${FRAGMENT_CALLBACK_HOST}:${FRAGMENT_CALLBACK_PORT}${FRAGMENT_CALLBACK_PATH}`;
const FRAGMENT_AUTHORIZE_URL = "https://pollinations.ai";
const FRAGMENT_TIMEOUT_MS = 5 * 60 * 1000;

// Device code flow (remote) constants
const DEVICE_CODE_URL = "https://enter.pollinations.ai/api/device/code";
const DEVICE_TOKEN_URL = "https://enter.pollinations.ai/api/device/token";
const DEVICE_POLL_INTERVAL_MS = 5000;
const DEVICE_TIMEOUT_MS = 15 * 60 * 1000;
const DEVICE_FETCH_TIMEOUT_MS = 30 * 1000;

const PROFILE_ID = "pollinations:default";

// ── Fragment flow helpers ────────────────────────────────────────────────

function generateState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function buildFragmentAuthorizeUrl(redirectUri: string): string {
  const url = new URL(FRAGMENT_AUTHORIZE_URL);
  url.searchParams.set("redirect_url", redirectUri);
  return url.toString();
}

function buildCallbackUri(state: string): string {
  const url = new URL(FRAGMENT_REDIRECT_URI);
  url.searchParams.set("state", state);
  return url.toString();
}

function parseFragmentRedirect(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  try {
    const url = new URL(trimmed);
    const hash = url.hash.slice(1);
    if (!hash) return undefined;
    const params = new URLSearchParams(hash);
    return params.get("api_key") ?? undefined;
  } catch {
    const hash = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
    try {
      const params = new URLSearchParams(hash);
      return params.get("api_key") ?? undefined;
    } catch {
      return undefined;
    }
  }
}

// ── Fragment flow (local) ────────────────────────────────────────────────

async function waitForFragmentCallback(params: {
  state: string;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const timeoutMs = params.timeoutMs ?? FRAGMENT_TIMEOUT_MS;
  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      finish(new Error("Pollinations login callback timed out. Paste the redirect URL manually."));
    }, timeoutMs);

    const server = createServer((req, res) => {
      try {
        const requestUrl = new URL(
          req.url ?? "/",
          `http://${FRAGMENT_CALLBACK_HOST}:${FRAGMENT_CALLBACK_PORT}`,
        );

        // Callback: Pollinations redirected the browser here
        if (requestUrl.pathname === FRAGMENT_CALLBACK_PATH && req.method === "GET") {
          const state = requestUrl.searchParams.get("state");
          if (state !== params.state) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "text/plain");
            res.end("Invalid state parameter");
            return;
          }

          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(FRAGMENT_CALLBACK_HTML);
          params.onProgress?.("Authentication page loaded, extracting key...");
          return;
        }

        // Token: JS on the callback page POSTs the api_key here
        if (requestUrl.pathname === FRAGMENT_TOKEN_PATH && req.method === "POST") {
          let body = "";
          req.on("data", (chunk: string) => {
            body += chunk;
          });
          req.on("end", () => {
            if (!body || body.trim().length === 0) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "text/plain");
              res.end("Missing API key");
              return;
            }
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/plain");
            res.end("OK");
            finish(undefined, body.trim());
          });
          return;
        }

        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain");
        res.end("Not found");
      } catch (err) {
        finish(err instanceof Error ? err : new Error("Pollinations callback server error"));
      }
    });

    const finish = (err?: Error, apiKey?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", onAbort);
      try { server.close(); } catch { /* best-effort cleanup */ }
      if (err) { reject(err); return; }
      if (apiKey) { resolve(apiKey); }
    };

    const onAbort = () => finish(new Error("Pollinations login cancelled"));
    params.signal?.addEventListener("abort", onAbort, { once: true });
    if (params.signal?.aborted) { onAbort(); return; }

    server.once("error", (err) => {
      finish(err instanceof Error ? err : new Error("Pollinations callback server error"));
    });
    server.listen(FRAGMENT_CALLBACK_PORT, FRAGMENT_CALLBACK_HOST, () => {
      params.onProgress?.(
        `Waiting for Pollinations login callback on ${FRAGMENT_REDIRECT_URI}...`,
      );
    });
  });
}

const FRAGMENT_CALLBACK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Pollinations Login</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0d1117; color: #c9d1d9; }
  .card { text-align: center; padding: 2rem; background: #161b22; border-radius: 12px; border: 1px solid #30363d; }
  h2 { margin: 0 0 0.5rem; color: #58a6ff; }
  p { margin: 0; color: #8b949e; }
</style>
</head>
<body>
<div class="card">
  <h2>Authentication successful</h2>
  <p>You may close this window and return to OpenClaw.</p>
</div>
<script>
  (function() {
    var hash = window.location.hash.slice(1);
    if (!hash) return;
    var params = new URLSearchParams(hash);
    var apiKey = params.get('api_key');
    if (apiKey) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/pollinations/token', true);
      xhr.send(apiKey);
    }
  })();
</script>
</body>
</html>`;

async function runFragmentFlow(ctx: ProviderAuthContext): Promise<string> {
  const progress = ctx.prompter.progress("Starting Pollinations login...");
  try {
    const state = generateState();
    const callbackUri = buildCallbackUri(state);
    const authorizeUrl = buildFragmentAuthorizeUrl(callbackUri);

    await ctx.prompter.note(
      [
        "Browser will open for Pollinations authentication.",
        "If the callback does not auto-complete, paste the redirect URL.",
        "",
        `Redirect URI: ${callbackUri}`,
      ].join("\n"),
      "Pollinations Login",
    );

    const callbackPromise = waitForFragmentCallback({
      state,
      onProgress: (message) => progress.update(message),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }).catch(async (error: unknown) => {
      if (ctx.signal?.aborted) {
        throw error;
      }
      progress.update("Callback not detected; waiting for redirect URL...");
      const input = await ctx.prompter.text({
        message: "Paste the Pollinations redirect URL",
        placeholder: `${callbackUri}#api_key=...`,
        validate: (value: string) => (value.trim().length > 0 ? undefined : "Required"),
      });
      const apiKey = parseFragmentRedirect(input);
      if (!apiKey) {
        throw new Error("Could not extract API key from the redirect URL.");
      }
      return apiKey;
    });
    void callbackPromise.catch(() => undefined);

    try {
      await ctx.openUrl(authorizeUrl);
      ctx.runtime.log(`Open: ${authorizeUrl}`);
    } catch {
      ctx.runtime.log(`Open manually: ${authorizeUrl}`);
    }

    return await callbackPromise;
  } catch (err) {
    progress.stop("Pollinations login failed");
    throw new Error(`Pollinations login failed: ${formatErrorMessage(err)}`, { cause: err });
  }
}

// ── Device code flow (remote/VPS) ────────────────────────────────────────

async function requestDeviceCode(fetchImpl: typeof fetch): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
}> {
  const response = await fetchImpl(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(DEVICE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Pollinations device code request failed (${response.status}): ${text || "unknown error"}`,
    );
  }
  const body = (await response.json()) as Record<string, unknown>;
  const deviceCode = typeof body.device_code === "string" ? body.device_code : undefined;
  const userCode = typeof body.user_code === "string" ? body.user_code : undefined;
  const verificationUri =
    typeof body.verification_uri === "string" ? body.verification_uri : undefined;
  if (!deviceCode || !userCode) {
    throw new Error("Pollinations device code response missing required fields.");
  }
  return {
    deviceCode,
    userCode,
    verificationUri: verificationUri ?? "/device",
  };
}

async function pollDeviceToken(
  fetchImpl: typeof fetch,
  deviceCode: string,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + DEVICE_TIMEOUT_MS;
  const deadlineSignal = AbortSignal.timeout(DEVICE_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;

  while (Date.now() < deadline) {
    if (combinedSignal.aborted) {
      throw new Error("Pollinations device code flow cancelled or timed out.");
    }

    try {
      const response = await fetchImpl(DEVICE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: deviceCode }),
        signal: AbortSignal.any([combinedSignal, AbortSignal.timeout(DEVICE_FETCH_TIMEOUT_MS)]),
      });

      if (response.ok) {
        const body = (await response.json()) as Record<string, unknown>;
        const accessToken =
          typeof body.access_token === "string" ? body.access_token : undefined;
        if (accessToken) {
          return accessToken;
        }
        throw new Error("Pollinations device code response missing access_token.");
      }

      if (response.status === 403 || response.status >= 500) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `Pollinations device authorization failed (${response.status}): ${text || "unknown error"}`,
        );
      }

      // 400/404 means still pending — wait and retry
      await sleep(DEVICE_POLL_INTERVAL_MS);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error("Pollinations device code flow cancelled or timed out.");
      }
      await sleep(DEVICE_POLL_INTERVAL_MS);
    }
  }

  throw new Error("Pollinations device code flow timed out.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runDeviceCodeFlow(ctx: ProviderAuthContext): Promise<string> {
  const progress = ctx.prompter.progress("Requesting Pollinations device code...");
  try {
    const device = await requestDeviceCode(fetch);

    const verificationUrl = `https://enter.pollinations.ai${device.verificationUri}`;
    await ctx.prompter.note(
      [
        "Open this URL and enter the device code:",
        "",
        `  URL: ${verificationUrl}`,
        `  Code: ${device.userCode}`,
      ].join("\n"),
      "Pollinations Device Login",
    );

    progress.update("Waiting for device authorization...");
    const accessToken = await pollDeviceToken(fetch, device.deviceCode, ctx.signal);
    progress.stop("Pollinations login complete");
    return accessToken;
  } catch (err) {
    progress.stop("Pollinations login failed");
    throw new Error(`Pollinations login failed: ${formatErrorMessage(err)}`, { cause: err });
  }
}

// ── Public entry point ───────────────────────────────────────────────────

export async function loginPollinations(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const apiKey = ctx.isRemote ? await runDeviceCodeFlow(ctx) : await runFragmentFlow(ctx);

  const metadata: Record<string, string> = {
    authFlow: ctx.isRemote ? "device-code" : "fragment",
  };

  const credential = {
    ...buildApiKeyCredential(PROVIDER_ID, apiKey, metadata),
    displayName: "Pollinations",
  };

  return {
    profiles: [{ profileId: PROFILE_ID, credential }],
    configPatch: applyPollinationsConfig(ctx.config),
    defaultModel: POLLINATIONS_DEFAULT_MODEL_REF,
    notes: [
      "Pollinations login complete. The API key is stored in the default Pollinations auth profile.",
    ],
  };
}

export function createPollinationsOAuthAuthMethod(): ProviderAuthMethod {
  return {
    id: POLLINATIONS_AUTH_METHOD_ID,
    label: "Pollinations Login",
    hint: "Browser sign-in",
    kind: "oauth",
    wizard: {
      choiceId: POLLINATIONS_AUTH_CHOICE_ID,
      choiceLabel: "Pollinations Login",
      choiceHint: "Browser sign-in",
      groupId: PROVIDER_ID,
      groupLabel: "Pollinations",
      groupHint: "Login or API key",
      methodId: POLLINATIONS_AUTH_METHOD_ID,
    },
    run: async (ctx) => await loginPollinations(ctx),
  };
}
