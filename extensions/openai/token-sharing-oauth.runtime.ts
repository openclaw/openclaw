import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { createLocalJWKSet, decodeJwt, jwtVerify, type JSONWebKeySet } from "jose";
import type { ProviderAuthContext, ProviderAuthResult } from "openclaw/plugin-sdk/plugin-entry";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { buildOauthProviderAuthResult } from "openclaw/plugin-sdk/provider-auth-result";
import {
  generateOAuthState,
  generatePKCE,
  oauthErrorHtml,
  oauthSuccessHtml,
  resolveOAuthTokenExpiresAt,
  withOAuthLoginAbort,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { OPENAI_DEFAULT_MODEL } from "./default-models.js";
import {
  IDENTITY_AUTH_FLOW,
  TOKEN_SHARING_AUTH_FLOW,
  TOKEN_SHARING_CLIENT_ID,
  TOKEN_SHARING_ISSUER,
  TOKEN_SHARING_REDIRECT_URI,
  TOKEN_SHARING_RESOURCE,
  TOKEN_SHARING_SCOPE,
} from "./token-sharing.js";

const TOKEN_ENDPOINT = `${TOKEN_SHARING_ISSUER}/api/accounts/oauth/token`;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
type LoginOwner = Pick<ProviderAuthContext, "signal" | "assertCurrent">;

async function requestJson(url: string, owner: LoginOwner, body?: URLSearchParams) {
  owner.signal?.throwIfAborted();
  owner.assertCurrent?.();
  const { response, release } = await fetchWithSsrFGuard({
    url,
    policy: { hostnameAllowlist: ["auth.openai.com"] },
    mode: "trusted_env_proxy",
    requireHttps: true,
    maxRedirects: 0,
    capture: false,
    timeoutMs: 30_000,
    signal: owner.signal,
    beforeRequest: owner.assertCurrent,
    auditContext: "openai-token-sharing-oauth",
    ...(body
      ? {
          init: {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
          },
        }
      : {}),
  });
  try {
    const bytes = await readResponseWithLimit(response, MAX_RESPONSE_BYTES);
    owner.signal?.throwIfAborted();
    owner.assertCurrent?.();
    let json: Record<string, unknown> | undefined;
    try {
      json = asOptionalRecord(JSON.parse(Buffer.from(bytes).toString("utf8")));
    } catch {
      // Provider bodies can contain credentials: report bounded status, never the body.
    }
    if (!response.ok) {
      const invalidGrant = json?.error === "invalid_grant";
      throw Object.assign(
        new Error(
          invalidGrant
            ? "ChatGPT connection expired or was revoked. Sign in again to reconnect."
            : `ChatGPT authentication request failed (HTTP ${response.status}). Retry sign-in later.`,
        ),
        {
          oauthRefreshFailure: {
            status: response.status,
            ...(invalidGrant ? { reason: "invalid_grant", errorType: "invalid_grant" } : {}),
          },
        },
      );
    }
    if (!json) {
      throw new Error("ChatGPT authentication returned an invalid response.");
    }
    return json;
  } finally {
    await release();
  }
}

async function verifyIdentity(
  idToken: string,
  clientId: string,
  owner: LoginOwner,
  nonce?: string,
) {
  const keys = await requestJson(`${TOKEN_SHARING_ISSUER}/.well-known/jwks.json`, owner);
  const { payload } = await jwtVerify(idToken, createLocalJWKSet(keys as JSONWebKeySet), {
    issuer: TOKEN_SHARING_ISSUER,
    audience: clientId,
    algorithms: ["RS256"],
    requiredClaims: ["iss", "aud", "sub", "iat", "exp"],
  });
  if (
    !payload.sub ||
    (nonce !== undefined && payload.nonce !== nonce) ||
    (payload.azp !== undefined && payload.azp !== clientId) ||
    (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)
  ) {
    throw new Error("ChatGPT sign-in identity could not be verified. Start sign-in again.");
  }
  owner.assertCurrent?.();
  owner.signal?.throwIfAborted();
  return payload.sub;
}

async function readCredential(params: {
  json: Record<string, unknown>;
  clientId: string;
  owner: LoginOwner;
  nonce?: string;
  previous?: OAuthCredential;
}): Promise<{ credential: OAuthCredential; subject: string }> {
  const { json, previous, clientId, owner } = params;
  const access = normalizeOptionalString(json.access_token);
  const refresh = normalizeOptionalString(json.refresh_token) ?? previous?.refresh;
  const expires = resolveOAuthTokenExpiresAt(json.expires_in);
  const idToken = normalizeOptionalString(json.id_token) ?? previous?.idToken;
  if (
    !access ||
    !refresh ||
    expires === undefined ||
    !idToken ||
    typeof json.token_type !== "string" ||
    json.token_type.toLowerCase() !== "bearer"
  ) {
    throw new Error("ChatGPT did not return a complete renewable credential. Start sign-in again.");
  }
  // Initial identity is signature-verified; refresh may omit its unchanged ID token.
  const subject =
    json.id_token || !previous
      ? await verifyIdentity(idToken, clientId, owner, params.nonce)
      : decodeJwt(idToken).sub;
  if (!subject || (previous?.idToken && decodeJwt(previous.idToken).sub !== subject)) {
    throw new Error("ChatGPT account changed during refresh. Sign in again to reconnect.");
  }
  const scope = normalizeOptionalString(json.scope);
  if (!previous && scope === undefined) {
    throw new Error("ChatGPT did not report the granted scopes. Start sign-in again.");
  }
  const sharing =
    scope === undefined
      ? previous?.authFlow === TOKEN_SHARING_AUTH_FLOW
      : ["resource.invoke", "chatgpt.tokens.use.direct"].every((required) =>
          scope.split(/\s+/u).includes(required),
        );
  return {
    subject,
    credential: {
      ...previous,
      type: "oauth",
      provider: "openai",
      access,
      refresh,
      expires,
      idToken,
      clientId,
      issuer: TOKEN_SHARING_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      authFlow: sharing ? TOKEN_SHARING_AUTH_FLOW : IDENTITY_AUTH_FLOW,
      displayName: sharing ? "ChatGPT — Token Sharing" : "ChatGPT — Identity only",
    },
  };
}

/** The auth-profile owner serializes refresh and atomically persists the returned rotation. */
export async function refreshTokenSharingCredential(
  credential: OAuthCredential,
): Promise<OAuthCredential> {
  if (
    !credential.clientId ||
    credential.issuer !== TOKEN_SHARING_ISSUER ||
    credential.tokenEndpoint !== TOKEN_ENDPOINT
  ) {
    throw new Error("ChatGPT token-sharing registration is missing. Sign in again to reconnect.");
  }
  const json = await requestJson(
    TOKEN_ENDPOINT,
    {},
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credential.clientId,
      refresh_token: credential.refresh,
      resource: TOKEN_SHARING_RESOURCE,
    }),
  );
  return (
    await readCredential({ json, clientId: credential.clientId, owner: {}, previous: credential })
  ).credential;
}

/** Local authorization owns the listener, state, verifier, and callback lifetime together. */
export async function loginTokenSharing(
  ctx: ProviderAuthContext,
  clientId: string | undefined = TOKEN_SHARING_CLIENT_ID,
): Promise<ProviderAuthResult> {
  if (!clientId) {
    throw new Error(
      "ChatGPT token sharing needs an OpenAI-approved OpenClaw OAuth client. This preview build is awaiting registration.",
    );
  }
  if (ctx.isRemote) {
    throw new Error(
      "Complete ChatGPT token-sharing sign-in on the computer running your browser. Its localhost:8080 callback must reach this OpenClaw process.",
    );
  }
  const owner = {
    ...ctx,
    signal: AbortSignal.any([
      AbortSignal.timeout(LOGIN_TIMEOUT_MS),
      ...(ctx.signal ? [ctx.signal] : []),
    ]),
  };
  owner.assertCurrent?.();
  const { verifier, challenge } = await generatePKCE();
  const state = generateOAuthState();
  const nonce = generateOAuthState();
  const url = new URL(`${TOKEN_SHARING_ISSUER}/api/accounts/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: TOKEN_SHARING_REDIRECT_URI,
    resource: TOKEN_SHARING_RESOURCE,
    scope: TOKEN_SHARING_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
  }).toString();
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  let callbackConsumed = false;
  let browserResponse: ServerResponse | undefined;
  const callback = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Register a rejection handler before browser I/O, which can outlive the callback.
  void callback.catch(() => undefined);
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Connection", "close");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    let callbackUrl: URL;
    try {
      callbackUrl = new URL(request.url ?? "/", TOKEN_SHARING_REDIRECT_URI);
    } catch {
      response.writeHead(400).end(oauthErrorHtml("Invalid sign-in callback."));
      return;
    }
    if (
      request.method !== "GET" ||
      callbackUrl.pathname !== "/auth/callback" ||
      callbackUrl.searchParams.getAll("state").length !== 1 ||
      callbackUrl.searchParams.get("state") !== state ||
      callbackConsumed
    ) {
      response
        .writeHead(400)
        .end(oauthErrorHtml("Invalid or expired sign-in callback. Return to OpenClaw to retry."));
      return;
    }
    callbackConsumed = true;
    try {
      owner.assertCurrent?.();
      owner.signal.throwIfAborted();
      if (callbackUrl.searchParams.has("error")) {
        throw new Error(
          callbackUrl.searchParams.get("error") === "access_denied"
            ? "ChatGPT authorization was declined. Start sign-in again when ready."
            : "ChatGPT authorization failed. Start sign-in again.",
        );
      }
      const code = callbackUrl.searchParams.get("code");
      if (!code || callbackUrl.searchParams.getAll("code").length !== 1) {
        throw new Error(
          "ChatGPT callback did not contain an authorization code. Start sign-in again.",
        );
      }
      browserResponse = response;
      resolveCode(code);
    } catch (error) {
      response
        .writeHead(400)
        .end(oauthErrorHtml("Authorization did not complete. Return to OpenClaw to retry."));
      rejectCode(error instanceof Error ? error : new Error("ChatGPT authorization failed."));
    }
  });
  try {
    await withOAuthLoginAbort(
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(8080, "localhost", resolve);
      }),
      owner.signal,
    );
    owner.assertCurrent?.();
    await ctx.prompter.note(
      "Authorize eligible Responses API calls using your ChatGPT allowance. Token sharing does not grant access to conversations, Codex history, or connected apps.",
      "Sign in with ChatGPT — Token Sharing",
    );
    owner.assertCurrent?.();
    owner.signal.throwIfAborted();
    await withOAuthLoginAbort(ctx.openUrl(url.toString()), owner.signal);
    const code = await withOAuthLoginAbort(callback, owner.signal);
    const json = await requestJson(
      TOKEN_ENDPOINT,
      owner,
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: TOKEN_SHARING_REDIRECT_URI,
        resource: TOKEN_SHARING_RESOURCE,
      }),
    );
    const { credential, subject } = await readCredential({ json, clientId, nonce, owner });
    const profileName = createHash("sha256")
      .update(`${TOKEN_SHARING_ISSUER}\0${clientId}\0${subject}`)
      .digest("hex")
      .slice(0, 24);
    const sharing = credential.authFlow === TOKEN_SHARING_AUTH_FLOW;
    browserResponse
      ?.writeHead(200)
      .end(
        oauthSuccessHtml(
          sharing
            ? "ChatGPT token sharing is connected. You can return to OpenClaw."
            : "ChatGPT sign-in succeeded. Token sharing is disabled; return to OpenClaw to choose inference access.",
        ),
      );
    const result = buildOauthProviderAuthResult({
      providerId: "openai",
      profilePrefix: "openai:token-sharing",
      profileName,
      defaultModel: OPENAI_DEFAULT_MODEL,
      access: credential.access,
      refresh: credential.refresh,
      expires: credential.expires,
      credentialExtra: credential,
      ...(sharing ? {} : { configPatch: {} }),
      notes: [
        sharing
          ? "ChatGPT token sharing is connected. Eligible Responses requests use your ChatGPT allowance."
          : "ChatGPT sign-in succeeded, but token sharing is disabled. Sign in again and enable sharing, or explicitly choose another inference credential.",
      ],
    });
    if (!sharing) {
      // Identity-only login must not change the model or silently choose another funding source.
      return { profiles: result.profiles, notes: result.notes };
    }
    return result;
  } catch (error) {
    browserResponse
      ?.writeHead(400)
      .end(oauthErrorHtml("Sign-in did not complete. Return to OpenClaw for details and retry."));
    throw error;
  } finally {
    server.close();
    if (browserResponse && !browserResponse.writableFinished) {
      browserResponse.once("finish", () => server.closeAllConnections());
    } else {
      server.closeAllConnections();
    }
  }
}
