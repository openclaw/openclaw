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

const webhookRequestHandler: RequestListener = (req, res) => {
  void (async () => {
    const handled = await handleZaloWebhookRequestInternal(req, res);
    if (!handled) {
      res.statusCode = 404;
      res.end("not found");
    }
  })();
};

const unregisterTargets: Array<() => void> = [];

function registerTarget(params: {
  path: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  config?: OpenClawConfig;
  acceptWebhook?: (rawEvent: string) => Promise<void>;
}): void {
  unregisterTargets.push(
    registerZaloWebhookTarget({
      account: DEFAULT_ACCOUNT,
      config: params.config ?? {},
      runtime: {} as ZaloRuntimeEnv,
      secret: "secret",
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

async function postWebhook(
  baseUrl: string,
  path: string,
  body = "{}",
  { secret = "secret", contentType = "application/json", forwardedFor = "" } = {},
) {
  return await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "x-bot-api-secret-token": secret,
      "content-type": contentType,
      ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
    },
    body,
  });
}

async function reachesRateLimit(
  request: (index: number) => Promise<Response>,
  attempts: number,
  checkUnauthorized = false,
) {
  for (let i = 0; i < attempts; i += 1) {
    const response = await request(i);
    if (checkUnauthorized) {
      expect([401, 429]).toContain(response.status);
    }
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

  it.each([
    ["non-object payload", "null", {}, 400],
    ["non-JSON content type", "{}", { contentType: "text/plain" }, 415],
    [
      "invalid secret before invalid content type",
      "not-json",
      { secret: "invalid-token", contentType: "text/plain" }, // pragma: allowlist secret
      401,
    ],
  ] as const)("rejects %s", async (_name, body, headers, status) => {
    registerTarget({ path: "/hook" });
    await withServer(webhookRequestHandler, async (baseUrl) => {
      const response = await postWebhook(baseUrl, "/hook", body, headers);
      expect(response.status).toBe(status);
      if (status === 400) {
        expect(await response.text()).toBe("Bad Request");
      }
    });
  });

  it("rejects ambiguous routing when multiple targets match the same secret", async () => {
    const sinkA = vi.fn();
    const sinkB = vi.fn();
    registerTarget({ path: "/hook", statusSink: sinkA });
    registerTarget({ path: "/hook", statusSink: sinkB });

    await withServer(webhookRequestHandler, async (baseUrl) => {
      const response = await postWebhook(baseUrl, "/hook");

      expect(response.status).toBe(401);
      expect(sinkA).not.toHaveBeenCalled();
      expect(sinkB).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])(
    "acknowledges only successful durable admission (failed=%s)",
    async (failed) => {
      const admission = Promise.withResolvers<void>();
      const acceptWebhook = vi.fn(async () => {
        await admission.promise;
      });
      const body = '{ "event_name": "message.text.received", "extra": true }';
      registerTarget({ path: "/hook-durable-ack", acceptWebhook });

      try {
        await withServer(webhookRequestHandler, async (baseUrl) => {
          let settled = false;
          const responsePromise = postWebhook(baseUrl, "/hook-durable-ack", body).then(
            (response) => {
              settled = true;
              return response;
            },
          );

          await vi.waitFor(() => expect(acceptWebhook).toHaveBeenCalledTimes(1));
          expect(acceptWebhook).toHaveBeenCalledWith(body);
          expect(settled).toBe(false);
          if (failed) {
            admission.reject(new Error("sqlite unavailable"));
          } else {
            admission.resolve();
          }
          const response = await responsePromise;
          expect(response.status).toBe(failed ? 500 : 200);
          expect(response.headers.get("x-openclaw-delivery-accepted")).toBe(
            failed ? null : "durable",
          );
        });
      } finally {
        admission.resolve();
      }
    },
  );

  it.each([true, false])("rate limits query churn (unauthorized=%s)", async (unauthorized) => {
    const path = unauthorized ? "/hook-query-status" : "/hook-query-rate";
    registerTarget({ path });
    await withServer(webhookRequestHandler, async (baseUrl) => {
      const saw429 = await reachesRateLimit(
        (i) =>
          postWebhook(baseUrl, `${path}?nonce=${i}`, "{}", {
            secret: unauthorized ? "invalid-token" : "secret", // pragma: allowlist secret
          }),
        unauthorized ? 200 : 130,
        unauthorized,
      );
      expect(saw429).toBe(true);
      if (unauthorized) {
        expect(getZaloWebhookStatusCounterSizeForTest()).toBe(2);
      }
    });
  });

  it("does not let unauthorized floods rate-limit authenticated traffic from a different trusted forwarded client IP", async () => {
    registerTarget({
      path: "/hook-preauth-split",
      config: {
        gateway: { trustedProxies: ["127.0.0.1"] },
      } as OpenClawConfig,
    });

    await withServer(webhookRequestHandler, async (baseUrl) => {
      await reachesRateLimit(
        (i) =>
          postWebhook(baseUrl, `/hook-preauth-split?nonce=${i}`, "{}", {
            secret: "invalid-token", // pragma: allowlist secret
            forwardedFor: "203.0.113.10",
          }),
        130,
      );

      const validResponse = await postWebhook(
        baseUrl,
        "/hook-preauth-split",
        JSON.stringify({ event_name: "message.unsupported.received" }),
        { forwardedFor: "198.51.100.20" },
      );

      expect(validResponse.status).toBe(200);
    });
  });
});
