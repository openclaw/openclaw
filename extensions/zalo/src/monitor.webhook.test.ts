// Zalo tests cover monitor.webhook plugin behavior.
import type { RequestListener } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZaloRuntimeEnv } from "./monitor.types.js";
import { zaloWebhookRuntime } from "./monitor.webhook.js";
import type { ResolvedZaloAccount } from "./types.js";
import { ZaloWebhookPayloadError } from "./webhook-spool.js";

const {
  clearZaloWebhookSecurityStateForTest,
  getZaloWebhookStatusCounterSizeForTest,
  handleZaloWebhookRequest: handleZaloWebhookRequestInternal,
  registerZaloWebhookTarget,
} = zaloWebhookRuntime;

const DEFAULT_ACCOUNT: ResolvedZaloAccount = {
  accountId: "default",
  enabled: true,
  token: "tok",
  tokenSource: "config",
  config: {},
};

function createWebhookRequestHandler(): RequestListener {
  return (req, res) => {
    void (async () => {
      const handled = await handleZaloWebhookRequestInternal(req, res);
      if (!handled) {
        res.statusCode = 404;
        res.end("not found");
      }
    })();
  };
}

const webhookRequestHandler = createWebhookRequestHandler();

const unregisterTargets: Array<() => void> = [];

function registerTarget(params: {
  path: string;
  secret?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  account?: ResolvedZaloAccount;
  config?: OpenClawConfig;
  runtime?: Partial<ZaloRuntimeEnv>;
  acceptWebhook?: (rawEvent: string) => Promise<void>;
}): void {
  unregisterTargets.push(
    registerZaloWebhookTarget({
      account: params.account ?? DEFAULT_ACCOUNT,
      config: params.config ?? ({} as OpenClawConfig),
      runtime: (params.runtime ?? {}) as ZaloRuntimeEnv,
      secret: params.secret ?? "secret",
      path: params.path,
      acceptWebhook:
        params.acceptWebhook ??
        (async (rawEvent) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawEvent);
          } catch (error) {
            throw new ZaloWebhookPayloadError("invalid JSON", { cause: error });
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new ZaloWebhookPayloadError("payload must be an object");
          }
          params.statusSink?.({ lastInboundAt: Date.now() });
        }),
    }),
  );
}

async function postWebhook(params: {
  baseUrl: string;
  path: string;
  body: string;
  secret?: string;
}) {
  return await fetch(`${params.baseUrl}${params.path}`, {
    method: "POST",
    headers: {
      "x-bot-api-secret-token": params.secret ?? "secret",
      "content-type": "application/json",
    },
    body: params.body,
  });
}

async function postUntilRateLimited(params: {
  baseUrl: string;
  path: string;
  secret: string;
  withNonceQuery?: boolean;
  attempts?: number;
}): Promise<boolean> {
  const attempts = params.attempts ?? 130;
  for (let i = 0; i < attempts; i += 1) {
    const url = params.withNonceQuery
      ? `${params.baseUrl}${params.path}?nonce=${i}`
      : `${params.baseUrl}${params.path}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-bot-api-secret-token": params.secret,
        "content-type": "application/json",
      },
      body: "{}",
    });
    if (response.status === 429) {
      return true;
    }
  }
  return false;
}

describe("handleZaloWebhookRequest", () => {
  afterEach(() => {
    for (const unregister of unregisterTargets.splice(0)) {
      unregister();
    }
    clearZaloWebhookSecurityStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("returns 400 for non-object payloads", async () => {
    registerTarget({ path: "/hook" });

    await withServer(webhookRequestHandler, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/hook`, {
        method: "POST",
        headers: {
          "x-bot-api-secret-token": "secret",
          "content-type": "application/json",
        },
        body: "null",
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Bad Request");
    });
  });

  it("rejects ambiguous routing when multiple targets match the same secret", async () => {
    const sinkA = vi.fn();
    const sinkB = vi.fn();
    registerTarget({ path: "/hook", statusSink: sinkA });
    registerTarget({ path: "/hook", statusSink: sinkB });

    await withServer(webhookRequestHandler, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/hook`, {
        method: "POST",
        headers: {
          "x-bot-api-secret-token": "secret",
          "content-type": "application/json",
        },
        body: "{}",
      });

      expect(response.status).toBe(401);
      expect(sinkA).not.toHaveBeenCalled();
      expect(sinkB).not.toHaveBeenCalled();
    });
  });

  it("returns 415 for non-json content-type", async () => {
    registerTarget({ path: "/hook-content-type" });

    await withServer(webhookRequestHandler, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/hook-content-type`, {
        method: "POST",
        headers: {
          "x-bot-api-secret-token": "secret",
          "content-type": "text/plain",
        },
        body: "{}",
      });

      expect(response.status).toBe(415);
    });
  });

  it("waits for durable admission before acknowledging", async () => {
    let releaseAdmission = () => {};
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const acceptWebhook = vi.fn(async () => {
      await admission;
    });
    registerTarget({ path: "/hook-durable-ack", acceptWebhook });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        let settled = false;
        const responsePromise = postWebhook({
          baseUrl,
          path: "/hook-durable-ack",
          body: '{"event_name":"message.text.received"}',
        }).then((response) => {
          settled = true;
          return response;
        });

        await vi.waitFor(() => expect(acceptWebhook).toHaveBeenCalledTimes(1));
        expect(settled).toBe(false);
        releaseAdmission();
        const response = await responsePromise;
        expect(response.status).toBe(200);
        expect(response.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
      });
    } finally {
      releaseAdmission();
    }
  });

  it("passes the exact raw webhook JSON to durable admission", async () => {
    const acceptWebhook = vi.fn(async () => {});
    registerTarget({ path: "/hook-raw", acceptWebhook });
    const body = '{ "event_name": "message.text.received", "extra": true }';

    await withServer(webhookRequestHandler, async (baseUrl) => {
      const response = await postWebhook({ baseUrl, path: "/hook-raw", body });
      expect(response.status).toBe(200);
    });
    expect(acceptWebhook).toHaveBeenCalledWith(body);
  });

  it("does not acknowledge a durable admission failure", async () => {
    const acceptWebhook = vi.fn(async () => {
      throw new Error("sqlite unavailable");
    });
    registerTarget({ path: "/hook-append-failure", acceptWebhook });

    await withServer(webhookRequestHandler, async (baseUrl) => {
      const response = await postWebhook({
        baseUrl,
        path: "/hook-append-failure",
        body: '{"event_name":"message.text.received"}',
      });
      expect(response.status).toBe(500);
      expect(response.headers.get("x-openclaw-delivery-accepted")).toBeNull();
    });
  });

  it("does not grow status counters when query strings churn on unauthorized requests", async () => {
    registerTarget({ path: "/hook-query-status" });

    await withServer(webhookRequestHandler, async (baseUrl) => {
      let saw429 = false;
      for (let i = 0; i < 200; i += 1) {
        const response = await fetch(`${baseUrl}/hook-query-status?nonce=${i}`, {
          method: "POST",
          headers: {
            "x-bot-api-secret-token": "invalid-token", // pragma: allowlist secret
            "content-type": "application/json",
          },
          body: "{}",
        });
        expect([401, 429]).toContain(response.status);
        if (response.status === 429) {
          saw429 = true;
          break;
        }
      }

      expect(saw429).toBe(true);
      expect(getZaloWebhookStatusCounterSizeForTest()).toBe(2);
    });
  });

  it("rate limits authenticated requests even when query strings churn", async () => {
    registerTarget({ path: "/hook-query-rate" });

    await withServer(webhookRequestHandler, async (baseUrl) => {
      const saw429 = await postUntilRateLimited({
        baseUrl,
        path: "/hook-query-rate",
        secret: "secret", // pragma: allowlist secret
        withNonceQuery: true,
      });

      expect(saw429).toBe(true);
    });
  });

  it("does not let unauthorized floods rate-limit authenticated traffic from a different trusted forwarded client IP", async () => {
    registerTarget({
      path: "/hook-preauth-split",
      config: {
        gateway: {
          trustedProxies: ["127.0.0.1"],
        },
      } as OpenClawConfig,
    });

    await withServer(webhookRequestHandler, async (baseUrl) => {
      for (let i = 0; i < 130; i += 1) {
        const response = await fetch(`${baseUrl}/hook-preauth-split?nonce=${i}`, {
          method: "POST",
          headers: {
            "x-bot-api-secret-token": "invalid-token", // pragma: allowlist secret
            "content-type": "application/json",
            "x-forwarded-for": "203.0.113.10",
          },
          body: "{}",
        });
        if (response.status === 429) {
          break;
        }
      }

      const validResponse = await fetch(`${baseUrl}/hook-preauth-split`, {
        method: "POST",
        headers: {
          "x-bot-api-secret-token": "secret",
          "content-type": "application/json",
          "x-forwarded-for": "198.51.100.20",
        },
        body: JSON.stringify({ event_name: "message.unsupported.received" }),
      });

      expect(validResponse.status).toBe(200);
    });
  });

  it("still returns 401 before 415 when both secret and content-type are invalid", async () => {
    registerTarget({ path: "/hook-auth-before-type" });

    await withServer(webhookRequestHandler, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/hook-auth-before-type`, {
        method: "POST",
        headers: {
          "x-bot-api-secret-token": "invalid-token", // pragma: allowlist secret
          "content-type": "text/plain",
        },
        body: "not-json",
      });

      expect(response.status).toBe(401);
    });
  });
});
