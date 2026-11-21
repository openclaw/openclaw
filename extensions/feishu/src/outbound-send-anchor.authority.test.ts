import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { text } from "node:stream/consumers";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { feishuPlugin } from "../channel-plugin-api.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { feishuOutbound } from "./outbound.js";

const { resolveProxy } = vi.hoisted(() => ({ resolveProxy: vi.fn<() => Promise<undefined>>() }));

vi.mock("openclaw/plugin-sdk/extension-shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/extension-shared")>();
  return { ...actual, resolveAmbientNodeProxyAgent: resolveProxy };
});

const AUTH_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
const MESSAGE_PATH = "/open-apis/im/v1/messages";
const TOPIC_ROOT = "om_topic_root";
const http = Lark.defaultHttpInstance;
type RecordedRequest = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
};

function createCfg(): OpenClawConfig {
  const suffix = randomUUID();
  return {
    channels: {
      feishu: {
        enabled: true,
        appId: `cli_${suffix}`,
        appSecret: "loopback-secret", // pragma: allowlist secret
        accounts: {
          default: {
            appId: `cli_${suffix}`,
            appSecret: "loopback-secret", // pragma: allowlist secret
            enabled: true,
          },
        },
      },
    },
  } satisfies OpenClawConfig;
}

describe("Feishu topic anchoring over the real Lark SDK transport", () => {
  let server: ReturnType<typeof createServer>;
  let requests: RecordedRequest[];
  let token: string;
  let topicId: string;
  let interceptors: number[];
  let holdAuthRequest: (() => Promise<void>) | undefined;

  const paths = () => requests.map(({ method, path }) => `${method} ${path}`);
  const replyRequest = () =>
    requests.find(
      ({ method, path }) => method === "POST" && path === `${MESSAGE_PATH}/${TOPIC_ROOT}/reply`,
    );

  beforeEach(async () => {
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
    resolveProxy.mockResolvedValue(undefined);
    requests = [];
    interceptors = [];
    holdAuthRequest = undefined;
    token = `tat_${randomUUID()}`;
    // Successful lookups are cached per topic, so every case needs its own topic.
    topicId = `omt_${randomUUID()}`;

    server = createServer((request, response) => {
      const reply = (body: unknown, status = 200) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      void (async () => {
        const rawBody = await text(request);
        const record: RecordedRequest = {
          method: request.method ?? "",
          path: new URL(request.url ?? "/", "http://127.0.0.1").pathname,
          headers: request.headers,
          body: rawBody ? JSON.parse(rawBody) : undefined,
        };
        requests.push(record);
        if (record.path === AUTH_PATH) {
          reply({ code: 0, tenant_access_token: token, expire: 7200 });
          return;
        }
        if (record.headers.authorization !== `Bearer ${token}`) {
          reply({ code: 99991663, msg: "missing loopback authentication" }, 401);
          return;
        }
        reply({ code: 0, data: { message_id: "om_reply", items: [{ message_id: TOPIC_ROOT }] } });
      })().catch((error: unknown) => reply({ error: String(error) }, 500));
    });
    const origin = `http://127.0.0.1:${await listenOnLoopback(server)}`;
    interceptors.push(
      http.interceptors.request.use(
        (options) => {
          const upstream = new URL(options.url ?? "");
          if (upstream.origin === "https://open.feishu.cn") {
            options.url = new URL(`${upstream.pathname}${upstream.search}`, origin).toString();
            options.proxy = false;
          }
          return options;
        },
        undefined,
        { synchronous: true },
      ),
    );
    interceptors.push(
      http.interceptors.request.use(async (options) => {
        if (holdAuthRequest && new URL(options.url ?? "").pathname === AUTH_PATH) {
          await holdAuthRequest();
        }
        return options;
      }),
    );
  });

  afterEach(async () => {
    interceptors.forEach((interceptor) => http.interceptors.request.eject(interceptor));
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    resolveProxy.mockReset();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/extension-shared");
    vi.resetModules();
  });

  function sendOutbound(cfg: OpenClawConfig, signal?: AbortSignal) {
    return feishuOutbound.sendText?.({
      cfg,
      to: "chat:oc_group",
      text: "proof",
      threadId: topicId,
      accountId: "default",
      signal,
    });
  }

  function sendAction(cfg: OpenClawConfig, handoff?: () => void) {
    return feishuPlugin.actions?.handleAction?.({
      channel: "feishu",
      action: "send",
      cfg,
      params: { to: "chat:oc_group", text: "proof" },
      accountId: "default",
      sessionKey: `feishu:group:oc_group:topic:${topicId}`,
      toolContext: { currentChannelId: "oc_group", currentChannelProvider: "feishu" },
      assertDirectAdapterHandoff: handoff,
    });
  }

  it("replies inside the topic through the outbound adapter", async () => {
    const result = await sendOutbound(createCfg());

    expect(result?.messageId).toBe("om_reply");
    expect(paths()).toEqual([
      `POST ${AUTH_PATH}`,
      `GET ${MESSAGE_PATH}`,
      `POST ${MESSAGE_PATH}/${TOPIC_ROOT}/reply`,
    ]);
    expect(replyRequest()?.body).toMatchObject({ reply_in_thread: true });
  });

  it("replies inside the topic through the message action", async () => {
    const result = await sendAction(createCfg());

    expect(result).toMatchObject({ details: { ok: true, messageId: "om_reply" } });
    expect(paths()).toEqual([
      `POST ${AUTH_PATH}`,
      `GET ${MESSAGE_PATH}`,
      `POST ${MESSAGE_PATH}/${TOPIC_ROOT}/reply`,
    ]);
    expect(replyRequest()?.body).toMatchObject({ reply_in_thread: true });
  });

  it("retires the outbound sender before the topic lookup dispatches", async () => {
    const held = createDeferred<void>();
    const release = createDeferred<void>();
    holdAuthRequest = async () => {
      held.resolve();
      await release.promise;
    };
    const controller = new AbortController();
    const sending = sendOutbound(createCfg(), controller.signal);

    await held.promise;
    holdAuthRequest = undefined;
    controller.abort();
    release.resolve();

    await expect(sending).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it("retires the action sender before the topic lookup dispatches", async () => {
    const held = createDeferred<void>();
    const release = createDeferred<void>();
    holdAuthRequest = async () => {
      held.resolve();
      await release.promise;
    };
    let retired = false;
    const sending = sendAction(createCfg(), () => {
      if (retired) {
        throw new Error("retired");
      }
    });

    await held.promise;
    holdAuthRequest = undefined;
    retired = true;
    release.resolve();

    await expect(sending).rejects.toThrow();
    expect(requests).toEqual([]);
  });
});
