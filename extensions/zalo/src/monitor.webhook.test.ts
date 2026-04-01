import type { RequestListener } from "node:http";
import { createEmptyPluginRegistry } from "openclaw/plugin-sdk/testing";
import { setActivePluginRegistry } from "openclaw/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withServer } from "../../../test/helpers/http-test-server.js";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import {
  createImageLifecycleCore,
  createImageUpdate,
  createTextUpdate,
  expectImageLifecycleDelivery,
  postWebhookReplay,
} from "../test-support/lifecycle-test-support.js";
import {
  clearZaloWebhookSecurityStateForTest,
  getZaloWebhookRateLimitStateSizeForTest,
  getZaloWebhookStatusCounterSizeForTest,
  handleZaloWebhookRequest,
  registerZaloWebhookTarget,
} from "./monitor.js";
import type { ResolvedZaloAccount } from "./types.js";
const DEFAULT_ACCOUNT: ResolvedZaloAccount = {
  accountId: "default",
  enabled: true,
  token: "tok",
  tokenSource: "config",
  config: {},
};

const webhookRequestHandler: RequestListener = async (req, res) => {
  const handled = await handleZaloWebhookRequest(req, res);
  if (!handled) {
    res.statusCode = 404;
    res.end("not found");
  }
};

function registerTarget(params: {
  path: string;
  secret?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  account?: ResolvedZaloAccount;
  config?: OpenClawConfig;
  core?: PluginRuntime;
}): () => void {
  return registerZaloWebhookTarget({
    token: "tok",
    account: params.account ?? DEFAULT_ACCOUNT,
    config: params.config ?? ({} as OpenClawConfig),
    runtime: {},
    core: params.core ?? ({} as PluginRuntime),
    secret: params.secret ?? "secret",
    path: params.path,
    mediaMaxMb: 5,
    statusSink: params.statusSink,
  });
}

function createPairingAuthCore(params?: { storeAllowFrom?: string[]; pairingCreated?: boolean }): {
  core: PluginRuntime;
  readAllowFromStore: ReturnType<typeof vi.fn>;
  upsertPairingRequest: ReturnType<typeof vi.fn>;
} {
  const readAllowFromStore = vi.fn().mockResolvedValue(params?.storeAllowFrom ?? []);
  const upsertPairingRequest = vi
    .fn()
    .mockResolvedValue({ code: "PAIRCODE", created: params?.pairingCreated ?? false });
  const core = {
    logging: {
      shouldLogVerbose: () => false,
    },
    channel: {
      pairing: {
        readAllowFromStore,
        upsertPairingRequest,
        buildPairingReply: vi.fn(() => "Pairing code: PAIRCODE"),
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(() => false),
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
      },
    },
  } as unknown as PluginRuntime;
  return { core, readAllowFromStore, upsertPairingRequest };
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
    clearZaloWebhookSecurityStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
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

  it("deduplicates webhook replay by event_name + message_id", async () => {
    const sink = vi.fn();
    const unregister = registerTarget({ path: "/hook-replay", statusSink: sink });
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
        expect(sink).toHaveBeenCalledTimes(1);
      });
    } finally {
      unregister();
    }
  });

  it("keeps replay dedupe isolated per authenticated target", async () => {
    const sinkA = vi.fn();
    const sinkB = vi.fn();
    const unregisterA = registerTarget({
      path: "/hook-replay-scope",
      secret: "secret-a",
      statusSink: sinkA,
    });
    const unregisterB = registerTarget({
      path: "/hook-replay-scope",
      secret: "secret-b",
      statusSink: sinkB,
      account: {
        ...DEFAULT_ACCOUNT,
        accountId: "work",
      },
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
        const first = await fetch(`${baseUrl}/hook-replay-scope`, {
          method: "POST",
          headers: {
            "x-bot-api-secret-token": "secret-a",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        const second = await fetch(`${baseUrl}/hook-replay-scope`, {
          method: "POST",
          headers: {
            "x-bot-api-secret-token": "secret-b",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
      });

      expect(sinkA).toHaveBeenCalledTimes(1);
      expect(sinkB).toHaveBeenCalledTimes(1);
    } finally {
      unregisterA();
      unregisterB();
    }
  });

  it("downloads inbound image media from webhook photo_url and preserves display_name", async () => {
    const {
      core,
      finalizeInboundContextMock,
      recordInboundSessionMock,
      fetchRemoteMediaMock,
      saveMediaBufferMock,
    } = createImageLifecycleCore();
    const unregister = registerTarget({
      path: "/hook-image",
      core,
      account: {
        ...DEFAULT_ACCOUNT,
        config: {
          dmPolicy: "open",
        },
      },
    });
    const payload = createImageUpdate();

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/hook-image`, {
          method: "POST",
          headers: {
            "x-bot-api-secret-token": "secret",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        expect(response.status).toBe(200);
      });
    } finally {
      unregister();
    }

    await vi.waitFor(() => expect(fetchRemoteMediaMock).toHaveBeenCalledTimes(1));
    expectImageLifecycleDelivery({
      fetchRemoteMediaMock,
      saveMediaBufferMock,
      finalizeInboundContextMock,
      recordInboundSessionMock,
    });
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

  it("scopes DM pairing store reads and writes to accountId", async () => {
    const { core, readAllowFromStore, upsertPairingRequest } = createPairingAuthCore({
      pairingCreated: false,
    });
    const account: ResolvedZaloAccount = {
      ...DEFAULT_ACCOUNT,
      accountId: "work",
      config: {
        dmPolicy: "pairing",
        allowFrom: [],
      },
    };
    const unregister = registerTarget({
      path: "/hook-account-scope",
      account,
      core,
    });

    const payload = {
      event_name: "message.text.received",
      message: {
        from: { id: "123", name: "Attacker" },
        chat: { id: "dm-work", chat_type: "PRIVATE" },
        message_id: "msg-work-1",
        date: Math.floor(Date.now() / 1000),
        text: "hello",
      },
    };

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/hook-account-scope`, {
          method: "POST",
          headers: {
            "x-bot-api-secret-token": "secret",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        expect(response.status).toBe(200);
      });
    } finally {
      unregister();
    }

    expect(readAllowFromStore).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "zalo",
        accountId: "work",
      }),
    );
    expect(upsertPairingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "zalo",
        id: "123",
        accountId: "work",
      }),
    );
  });
});
