// Google Chat webhook durability proven through the production auth path.
//
// These tests drive the real inbound stack end to end: POST -> real webhook
// handler -> verifyGoogleChatRequest -> fetchChatCerts -> fetchWithSsrFGuard ->
// google-auth-library verifySignedJwtWithCertsAsync, with only global fetch
// stubbed to reroute the Google cert host to a loopback impersonator. The
// signing key is a throwaway RSA key generated in-process; the JWT is really
// signed and really verified. No credentials are mocked, no network leaves the
// machine. Same proof standard as the accepted reply-delivery proof in
// monitor.reply-delivery-failure.test.ts (#110147).
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { createFixedWindowRateLimiter } from "openclaw/plugin-sdk/webhook-ingress";
import { createWebhookInFlightLimiter } from "openclaw/plugin-sdk/webhook-request-guards";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { createGoogleChatIngressSpool } from "./monitor-ingress.js";
import type { WebhookTarget } from "./monitor-types.js";
import { createGoogleChatWebhookRequestHandler } from "./monitor-webhook.js";
import type { GoogleChatEvent } from "./types.js";

type GoogleChatIngressPayload = {
  version: 1;
  rawEvent: string;
};

const PROJECT_NUMBER = "123456789012";
const CHAT_ISSUER = "chat@system.gserviceaccount.com";
const KEY_ID = "loopback-chat-key-1";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: attackerPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
// google-auth-library passes this PEM straight into node crypto verify; an SPKI
// public-key PEM exercises the identical RSA-SHA256 signature check as the X509
// certificate PEMs Google serves.
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signChatJwt(
  payload: Record<string, unknown>,
  signingKey: typeof privateKey = privateKey,
): string {
  const header = base64UrlJson({ alg: "RS256", kid: KEY_ID, typ: "JWT" });
  const body = base64UrlJson(payload);
  const signature = cryptoSign("sha256", Buffer.from(`${header}.${body}`), signingKey).toString(
    "base64url",
  );
  return `${header}.${body}.${signature}`;
}

function signGoogleChatWebhookToken(): string {
  const now = Math.floor(Date.now() / 1000);
  return signChatJwt({
    iss: CHAT_ISSUER,
    aud: PROJECT_NUMBER,
    iat: now - 10,
    exp: now + 3600,
  });
}

function createGoogleImpersonator() {
  const certRequests: string[] = [];
  const handler = (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => {
    const url = new URL(req.url ?? "/", "http://stub.invalid");
    certRequests.push(url.pathname);
    if (
      req.method === "GET" &&
      url.pathname === "/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com"
    ) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ [KEY_ID]: publicKeyPem }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  };
  return { handler, certRequests };
}

function stubGoogleHostsFetch() {
  const realFetch = globalThis.fetch;
  let stubBaseUrl: string | undefined;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl);
    if (url.hostname === "www.googleapis.com" || url.hostname === "oauth2.googleapis.com") {
      if (!stubBaseUrl) {
        throw new Error("stub server base URL not installed");
      }
      return await realFetch(`${stubBaseUrl}${url.pathname}${url.search}`, init);
    }
    return await realFetch(input, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    pointAtStub: (baseUrl: string) => {
      stubBaseUrl = baseUrl;
    },
  };
}

const account = {
  accountId: "default",
  enabled: true,
  credentialSource: "none",
  config: {},
} as ResolvedGoogleChatAccount;

const inboundEvent = {
  type: "MESSAGE",
  space: { name: "spaces/AAA" },
  message: {
    name: "spaces/AAA/messages/authed-1",
    text: "authenticated hello",
    sender: { name: "users/123", displayName: "Real User" },
  },
  user: { name: "users/123", displayName: "Real User" },
  eventTime: "2026-03-22T00:00:00.000Z",
};

const stateDirs: string[] = [];
const disposers: Array<() => void> = [];

async function createStateDir(): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), "openclaw-googlechat-auth-"));
  const resolved = await realpath(created);
  stateDirs.push(resolved);
  return resolved;
}

function createQueue(stateDir: string) {
  return createChannelIngressQueueForTests<GoogleChatIngressPayload>({
    channelId: "googlechat",
    accountId: account.accountId,
    stateDir,
  });
}

function createSpool(params: {
  stateDir: string;
  deliver: (
    event: GoogleChatEvent,
    lifecycle: { onAdopted: () => void | Promise<void> },
  ) => Promise<void>;
}) {
  const spool = createGoogleChatIngressSpool({
    accountId: account.accountId,
    runtime: { log: vi.fn(), error: vi.fn() },
    queue: createQueue(params.stateDir),
    deliver: params.deliver,
  });
  disposers.push(spool.dispose);
  return spool;
}

function createAuthedWebhookHandler(target: WebhookTarget) {
  return createGoogleChatWebhookRequestHandler({
    webhookTargets: new Map([[target.path, [target]]]),
    webhookRateLimiter: createFixedWindowRateLimiter({
      windowMs: 60_000,
      maxRequests: 1_000,
      maxTrackedKeys: 1_000,
    }),
    webhookInFlightLimiter: createWebhookInFlightLimiter(),
    processEvent: vi.fn(async () => undefined),
  });
}

function createTarget(spool: ReturnType<typeof createSpool>): WebhookTarget {
  return {
    account,
    config: {} as OpenClawConfig,
    runtime: { log: vi.fn(), error: vi.fn() },
    core: {} as WebhookTarget["core"],
    path: "/googlechat",
    audienceType: "project-number",
    audience: PROJECT_NUMBER,
    statusSink: vi.fn(),
    mediaMaxMb: 5,
    ingress: spool,
  };
}

async function postWebhook(
  baseUrl: string,
  params: { bearer: string },
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${baseUrl}/googlechat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${params.bearer}`,
    },
    body: JSON.stringify(inboundEvent),
  });
  return { status: response.status, body: await response.text() };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dispose of disposers.splice(0).toReversed()) {
    dispose();
  }
  for (const stateDir of stateDirs.splice(0).toReversed()) {
    await rm(stateDir, { recursive: true, force: true });
  }
});

describe("Google Chat webhook durability through real JWT authentication", () => {
  it("journals a real signed webhook before ack and replays it once after a restart", async () => {
    const stateDir = await createStateDir();
    const fetchControl = stubGoogleHostsFetch();
    const google = createGoogleImpersonator();
    await withServer(google.handler, async (googleBaseUrl) => {
      fetchControl.pointAtStub(googleBaseUrl);
      const deliverBeforeRestart = vi.fn(async () => undefined);
      const spoolBeforeRestart = createSpool({
        stateDir,
        deliver: deliverBeforeRestart,
      });
      const handler = createAuthedWebhookHandler(createTarget(spoolBeforeRestart));

      await withServer(
        (req, res) => {
          void handler(req, res);
        },
        async (webhookBaseUrl) => {
          const response = await postWebhook(webhookBaseUrl, {
            bearer: signGoogleChatWebhookToken(),
          });
          expect(response.status).toBe(200);
          expect(response.body).toBe("{}");
        },
      );

      // The production auth path ran: the cert fetch went to the Google cert
      // host (rerouted to the loopback impersonator) and the RS256 signature
      // verified against the served key.
      const requestedUrls = fetchControl.fetchMock.mock.calls.map((call) => {
        const input = call[0] as RequestInfo | URL;
        return input instanceof Request ? input.url : String(input);
      });
      expect(
        requestedUrls.some((url) =>
          url.startsWith(
            "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com",
          ),
        ),
      ).toBe(true);
      // Google saw a 200 after real verification, but dispatch never ran.
      expect(deliverBeforeRestart).not.toHaveBeenCalled();
      expect(await createQueue(stateDir).listPending()).toEqual([
        expect.objectContaining({
          id: "spaces/AAA/messages/authed-1",
          laneKey: "space:spaces/AAA",
        }),
      ]);
      // Crash between ack and dispatch.
      spoolBeforeRestart.dispose();

      const deliverAfterRestart = vi.fn(
        async (_event: GoogleChatEvent, lifecycle: { onAdopted: () => void | Promise<void> }) => {
          await lifecycle.onAdopted();
        },
      );
      const spoolAfterRestart = createSpool({ stateDir, deliver: deliverAfterRestart });
      await spoolAfterRestart.drainOnce();
      await spoolAfterRestart.waitForIdle();

      expect(deliverAfterRestart).toHaveBeenCalledOnce();
      expect(deliverAfterRestart.mock.calls[0]?.[0]).toMatchObject({
        type: "MESSAGE",
        message: { name: "spaces/AAA/messages/authed-1", text: "authenticated hello" },
      });

      // The completed tombstone survives another restart: no second dispatch.
      spoolAfterRestart.dispose();
      const deliverAfterSecondRestart = vi.fn(async () => undefined);
      const spoolAfterSecondRestart = createSpool({
        stateDir,
        deliver: deliverAfterSecondRestart,
      });
      await spoolAfterSecondRestart.drainOnce();
      await spoolAfterSecondRestart.waitForIdle();
      expect(deliverAfterSecondRestart).not.toHaveBeenCalled();
    });
  });

  it("rejects a webhook signed by an unknown key before journaling anything", async () => {
    const stateDir = await createStateDir();
    const fetchControl = stubGoogleHostsFetch();
    const google = createGoogleImpersonator();
    await withServer(google.handler, async (googleBaseUrl) => {
      fetchControl.pointAtStub(googleBaseUrl);
      const deliver = vi.fn(async () => undefined);
      const spool = createSpool({ stateDir, deliver });
      const handler = createAuthedWebhookHandler(createTarget(spool));

      await withServer(
        (req, res) => {
          void handler(req, res);
        },
        async (webhookBaseUrl) => {
          const now = Math.floor(Date.now() / 1000);
          // Same claims and kid, but signed by a key the cert host never served.
          const forgedBearer = signChatJwt(
            { iss: CHAT_ISSUER, aud: PROJECT_NUMBER, iat: now - 10, exp: now + 3600 },
            attackerPrivateKey,
          );
          const response = await postWebhook(webhookBaseUrl, { bearer: forgedBearer });
          expect(response.status).toBe(401);
        },
      );
      await spool.drainOnce();
      await spool.waitForIdle();
      // The forged event was never journaled, so nothing replays.
      expect(deliver).not.toHaveBeenCalled();
      expect(await createQueue(stateDir).listPending()).toEqual([]);
    });
  });
});
