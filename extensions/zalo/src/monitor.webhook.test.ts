import { mkdtemp, realpath, rm } from "node:fs/promises";
// Zalo tests cover monitor.webhook plugin behavior.
import type { RequestListener } from "node:http";
import os from "node:os";
import path from "node:path";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import type { ZaloUpdate } from "./api.js";
import { createZaloIngressSpool, type ZaloIngressSpool } from "./monitor-ingress.js";
import type { ZaloRuntimeEnv } from "./monitor.types.js";
import {
  clearZaloWebhookSecurityStateForTest,
  getZaloWebhookRateLimitStateSizeForTest,
  getZaloWebhookStatusCounterSizeForTest,
  handleZaloWebhookRequest as handleZaloWebhookRequestInternal,
  registerZaloWebhookTarget,
  type ZaloWebhookIngress,
} from "./monitor.webhook.js";
import { createTextUpdate, postWebhookReplay } from "./test-support/lifecycle-test-support.js";
import type { ResolvedZaloAccount } from "./types.js";

const runDetachedWebhookWork = vi.hoisted(() => vi.fn((run: () => Promise<void>) => run()));

vi.mock("openclaw/plugin-sdk/webhook-request-guards", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/webhook-request-guards")>();
  return { ...actual, runDetachedWebhookWork };
});

const DEFAULT_ACCOUNT: ResolvedZaloAccount = {
  accountId: "default",
  enabled: true,
  token: "tok",
  tokenSource: "config",
  config: {},
};

function createFakeIngress(overrides?: Partial<ZaloWebhookIngress>): ZaloWebhookIngress {
  return {
    enqueue: vi.fn(async () => ({ kind: "accepted" }) as const),
    drainOnce: vi.fn(async () => undefined),
    ...overrides,
  };
}

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

function registerTarget(params: {
  path: string;
  secret?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  account?: ResolvedZaloAccount;
  config?: OpenClawConfig;
  core?: PluginRuntime;
  runtime?: Partial<ZaloRuntimeEnv>;
  ingress?: ZaloWebhookIngress;
}): () => void {
  return registerZaloWebhookTarget({
    token: "tok",
    account: params.account ?? DEFAULT_ACCOUNT,
    config: params.config ?? ({} as OpenClawConfig),
    runtime: (params.runtime ?? {}) as ZaloRuntimeEnv,
    core: params.core ?? ({} as PluginRuntime),
    secret: params.secret ?? "secret",
    path: params.path,
    webhookUrl: `https://example.com${params.path}`,
    webhookPath: params.path,
    mediaMaxMb: 5,
    canHostMedia: true,
    statusSink: params.statusSink,
    ingress: params.ingress ?? createFakeIngress(),
  });
}

const ingressStateDirs: string[] = [];
const ingressDisposers: Array<() => void> = [];

async function createIngressStateDir(): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), "openclaw-zalo-webhook-ingress-"));
  const resolved = await realpath(created);
  ingressStateDirs.push(resolved);
  return resolved;
}

async function createRealIngress(params: {
  accountId: string;
  dispatch: (update: ZaloUpdate) => Promise<void>;
}): Promise<ZaloIngressSpool> {
  const stateDir = await createIngressStateDir();
  const spool = createZaloIngressSpool({
    accountId: params.accountId,
    abortSignal: new AbortController().signal,
    queue: createChannelIngressQueueForTests({
      channelId: "zalo",
      accountId: params.accountId,
      stateDir,
    }),
    dispatch: params.dispatch,
  });
  ingressDisposers.push(spool.dispose);
  return spool;
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

async function postWebhookJson(params: {
  baseUrl: string;
  path: string;
  secret: string;
  payload: unknown;
}) {
  return fetch(`${params.baseUrl}${params.path}`, {
    method: "POST",
    headers: {
      "x-bot-api-secret-token": params.secret,
      "content-type": "application/json",
    },
    body: JSON.stringify(params.payload),
  });
}

async function expectTwoWebhookPostsOk(params: {
  baseUrl: string;
  first: { path: string; secret: string; payload: unknown };
  second: { path: string; secret: string; payload: unknown };
}) {
  const first = await postWebhookJson({
    baseUrl: params.baseUrl,
    path: params.first.path,
    secret: params.first.secret,
    payload: params.first.payload,
  });
  const second = await postWebhookJson({
    baseUrl: params.baseUrl,
    path: params.second.path,
    secret: params.second.secret,
    payload: params.second.payload,
  });

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
}

describe("handleZaloWebhookRequest", () => {
  afterEach(async () => {
    clearZaloWebhookSecurityStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    for (const dispose of ingressDisposers.splice(0).toReversed()) {
      dispose();
    }
    for (const stateDir of ingressStateDirs.splice(0).toReversed()) {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("returns 400 for non-object payloads", async () => {
    const unregister = registerTarget({ path: "/hook" });

    try {
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
    } finally {
      unregister();
    }
  });

  it("rejects ambiguous routing when multiple targets match the same secret", async () => {
    const sinkA = vi.fn();
    const sinkB = vi.fn();
    const unregisterA = registerTarget({ path: "/hook", statusSink: sinkA });
    const unregisterB = registerTarget({ path: "/hook", statusSink: sinkB });

    try {
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
    } finally {
      unregisterA();
      unregisterB();
    }
  });

  it("returns 415 for non-json content-type", async () => {
    const unregister = registerTarget({ path: "/hook-content-type" });

    try {
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
    } finally {
      unregister();
    }
  });

  it("journals the update before ack and drains it detached", async () => {
    const dispatch = vi.fn(async (_update: ZaloUpdate) => undefined);
    const ingress = await createRealIngress({ accountId: "default", dispatch });
    const unregister = registerTarget({ path: "/hook-durable", ingress });
    const payload = createTextUpdate({
      messageId: "msg-durable-1",
      userId: "123",
      userName: "",
      chatId: "123",
      text: "hello",
    });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const response = await postWebhookJson({
          baseUrl,
          path: "/hook-durable",
          secret: "secret",
          payload,
        });

        expect(response.status).toBe(200);
        await ingress.waitForIdle();
        expect(dispatch).toHaveBeenCalledOnce();
        expect(dispatch.mock.calls[0]?.[0].message?.message_id).toBe("msg-durable-1");
      });
    } finally {
      unregister();
    }
  });

  it("deduplicates webhook replay through the durable journal", async () => {
    runDetachedWebhookWork.mockClear();
    const dispatch = vi.fn(async (_update: ZaloUpdate) => undefined);
    const ingress = await createRealIngress({ accountId: "default", dispatch });
    const sink = vi.fn();
    const unregister = registerTarget({ path: "/hook-replay", statusSink: sink, ingress });
    const payload = createTextUpdate({
      messageId: "msg-replay-1",
      userId: "123",
      userName: "",
      chatId: "123",
      text: "hello",
    });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const { first, replay } = await postWebhookReplay({
          baseUrl,
          path: "/hook-replay",
          secret: "secret",
          payload,
        });

        expect(first.status).toBe(200);
        expect(replay.status).toBe(200);
        await ingress.waitForIdle();
        expect(dispatch).toHaveBeenCalledOnce();
        // Admission is acknowledged per delivery; the journal dedupes dispatch.
        expect(sink).toHaveBeenCalledTimes(2);
        expect(runDetachedWebhookWork).toHaveBeenCalledTimes(2);
      });
    } finally {
      unregister();
    }
  });

  it("responds 500 when the ingress append fails so Zalo redelivers", async () => {
    const error = vi.fn();
    const ingress = createFakeIngress({
      enqueue: vi.fn(async () => {
        throw new Error("sqlite wedged");
      }),
    });
    const unregister = registerTarget({
      path: "/hook-append-failure",
      runtime: { error },
      ingress,
    });
    const payload = createTextUpdate({
      messageId: "msg-append-failure-1",
      userId: "123",
      userName: "",
      chatId: "123",
      text: "hello",
    });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const response = await postWebhookJson({
          baseUrl,
          path: "/hook-append-failure",
          secret: "secret",
          payload,
        });

        expect(response.status).toBe(500);
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining("Zalo webhook ingress append failed"),
        );
        expect(ingress.drainOnce).not.toHaveBeenCalled();
      });
    } finally {
      unregister();
    }
  });

  it("keeps replay dedupe isolated per authenticated target", async () => {
    const sinkA = vi.fn();
    const sinkB = vi.fn();
    const ingressA = createFakeIngress();
    const ingressB = createFakeIngress();
    const unregisterA = registerTarget({
      path: "/hook-replay-scope",
      secret: "secret-a",
      statusSink: sinkA,
      ingress: ingressA,
    });
    const unregisterB = registerTarget({
      path: "/hook-replay-scope",
      secret: "secret-b",
      statusSink: sinkB,
      account: {
        ...DEFAULT_ACCOUNT,
        accountId: "work",
      },
      ingress: ingressB,
    });
    const payload = createTextUpdate({
      messageId: "msg-replay-scope-1",
      userId: "123",
      userName: "",
      chatId: "123",
      text: "hello",
    });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        await expectTwoWebhookPostsOk({
          baseUrl,
          first: { path: "/hook-replay-scope", secret: "secret-a", payload },
          second: { path: "/hook-replay-scope", secret: "secret-b", payload },
        });
      });

      // Each account owns its journal, so the same update is admitted once per target.
      expect(ingressA.enqueue).toHaveBeenCalledTimes(1);
      expect(ingressB.enqueue).toHaveBeenCalledTimes(1);
      expect(sinkA).toHaveBeenCalledTimes(1);
      expect(sinkB).toHaveBeenCalledTimes(1);
    } finally {
      unregisterA();
      unregisterB();
    }
  });

  it("accepts replay metadata when optional fields are missing", async () => {
    const sink = vi.fn();
    const unregister = registerTarget({ path: "/hook-replay-partial", statusSink: sink });
    const payload = {
      event_name: "message.text.received",
      message: {
        message_id: "msg-replay-partial-1",
        date: Math.floor(Date.now() / 1000),
        text: "hello",
      },
    };

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/hook-replay-partial`, {
          method: "POST",
          headers: {
            "x-bot-api-secret-token": "secret",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        expect(response.status).toBe(200);
      });

      expect(sink).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it("returns 429 when per-path request rate exceeds threshold", async () => {
    const unregister = registerTarget({ path: "/hook-rate" });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const saw429 = await postUntilRateLimited({
          baseUrl,
          path: "/hook-rate",
          secret: "secret", // pragma: allowlist secret
        });

        expect(saw429).toBe(true);
      });
    } finally {
      unregister();
    }
  });
  it("does not grow status counters when query strings churn on unauthorized requests", async () => {
    const unregister = registerTarget({ path: "/hook-query-status" });

    try {
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
    } finally {
      unregister();
    }
  });

  it("rate limits authenticated requests even when query strings churn", async () => {
    const unregister = registerTarget({ path: "/hook-query-rate" });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const saw429 = await postUntilRateLimited({
          baseUrl,
          path: "/hook-query-rate",
          secret: "secret", // pragma: allowlist secret
          withNonceQuery: true,
        });

        expect(saw429).toBe(true);
        expect(getZaloWebhookRateLimitStateSizeForTest()).toBe(1);
      });
    } finally {
      unregister();
    }
  });

  it("rate limits unauthorized secret guesses before authentication succeeds", async () => {
    const unregister = registerTarget({ path: "/hook-preauth-rate" });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const saw429 = await postUntilRateLimited({
          baseUrl,
          path: "/hook-preauth-rate",
          secret: "invalid-token", // pragma: allowlist secret
          withNonceQuery: true,
        });

        expect(saw429).toBe(true);
        expect(getZaloWebhookRateLimitStateSizeForTest()).toBe(1);
      });
    } finally {
      unregister();
    }
  });

  it("does not let unauthorized floods rate-limit authenticated traffic from a different trusted forwarded client IP", async () => {
    const unregister = registerTarget({
      path: "/hook-preauth-split",
      config: {
        gateway: {
          trustedProxies: ["127.0.0.1"],
        },
      } as OpenClawConfig,
    });

    try {
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
    } finally {
      unregister();
    }
  });

  it("still returns 401 before 415 when both secret and content-type are invalid", async () => {
    const unregister = registerTarget({ path: "/hook-auth-before-type" });

    try {
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
    } finally {
      unregister();
    }
  });
});
