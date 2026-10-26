import { WebClient, type WebClientOptions } from "@slack/web-api";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSlackLookupClient,
  createSlackReadClient,
  createSlackStartupAuthClient,
  createSlackWebClient,
  getSlackListenerWriteClient,
} from "./client.js";
import { startSlackStream } from "./streaming.js";

beforeEach(() => {
  for (const key of [
    "SLACK_API_URL",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "https_proxy",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_PROXY_CA_FILE",
  ]) {
    vi.stubEnv(key, undefined);
  }
});

type Api = {
  requests: { authorization?: string; method?: string; url?: string; body: string }[];
  options: WebClientOptions;
  socketClosed: Promise<void>;
};
async function withApi(mode: number | "drop" | "stall", use: (api: Api) => Promise<void>) {
  const requests: Api["requests"] = [];
  const { promise: socketClosed, resolve } = Promise.withResolvers<void>();
  await withServer(
    (request, response) => {
      const entry = {
        authorization: request.headers.authorization,
        method: request.method,
        url: request.url,
        body: "",
      };
      requests.push(entry);
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        entry.body += String(chunk);
      });
      request.socket.once("close", resolve);
      if (mode === "drop") {
        request.once("end", () => request.socket.destroy());
      } else if (mode !== "stall") {
        const send = () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
        };
        if (mode > 0) {
          setTimeout(send, mode);
        } else {
          send();
        }
      }
    },
    async (url) => use({ requests, socketClosed, options: { slackApiUrl: url + "/api/" } }),
  );
}
function withListener(
  mode: number | "drop",
  use: (api: Api, listener: WebClient, options: WebClientOptions) => Promise<void>,
  overrides: WebClientOptions = {},
) {
  return withApi(mode, async (api) => {
    const options = {
      ...api.options,
      retryConfig: { retries: 2, minTimeout: 1, maxTimeout: 1 },
      ...overrides,
    };
    await use(api, new WebClient("listener-fixture", options), options);
  });
}
function writer(
  listenerClient: WebClient,
  clientOptions: WebClientOptions,
  teamId = "TENTERPRISE1",
) {
  return getSlackListenerWriteClient({ listenerClient, clientOptions, teamId });
}
function requireWriter(listener: WebClient, options: WebClientOptions) {
  const client = writer(listener, options);
  if (!client) {
    throw new Error("missing Enterprise upload completion client");
  }
  return client;
}
const upload = (client: WebClient) =>
  client.files.completeUploadExternal({
    files: [{ id: "F123", title: "proof.txt" }],
    channel_id: "C123",
  });
const authResult = { ok: true, team_id: "TMOCK", user_id: "UMOCK" };
const rateLimited = (seconds: string) =>
  new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
    status: 429,
    headers: { "retry-after": seconds },
  });

describe("Slack Web API routing", () => {
  it("keeps lost stream responses one-shot without changing listener reads", async () => {
    await withListener(
      "drop",
      async ({ requests }, client, clientOptions) => {
        await expect(
          startSlackStream({
            client,
            clientOptions,
            channel: "C123",
            threadTs: "1700000000.000100",
            teamId: "TRECIPIENT",
            text: "one committed answer",
            chunks: [],
          }),
        ).rejects.toThrow();
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          authorization: "Bearer listener-fixture",
          url: "/api/chat.startStream",
        });
        expect(Object.fromEntries(new URLSearchParams(requests[0]?.body))).toMatchObject({
          team_id: "TENTERPRISE1",
          recipient_team_id: "TRECIPIENT",
        });
        await expect(client.auth.test()).rejects.toThrow();
        expect(requests.filter(({ url }) => url === "/api/auth.test")).toHaveLength(3);
      },
      { teamId: "TENTERPRISE1" },
    );
  });

  it.each(["transient failures", "rate limit"])(
    "retries startup auth after %s",
    async (failure) => {
      const fetch = vi.fn();
      if (failure === "transient failures") {
        fetch
          .mockRejectedValueOnce(new Error("request timed out"))
          .mockRejectedValueOnce(new Error("connection reset"));
      } else {
        fetch.mockResolvedValueOnce(rateLimited("0"));
      }
      fetch.mockResolvedValueOnce(Response.json(authResult));
      await expect(
        createSlackStartupAuthClient("startup-fixture", { fetch: fetch as never }).auth.test(),
      ).resolves.toMatchObject(authResult);
      expect(fetch).toHaveBeenCalledTimes(failure === "transient failures" ? 3 : 2);
    },
  );

  it("aborts a stalled-header lookup after one request", async () => {
    await withApi("stall", async ({ requests, options, socketClosed }) => {
      await expect(
        createSlackLookupClient("lookup-fixture", { ...options, timeout: 50 }).auth.test(),
      ).rejects.toThrow();
      await socketClosed;
      expect(requests).toMatchObject([{ method: "POST", url: "/api/auth.test" }]);
    });
  });

  it("rejects rate limits without sleeping through Retry-After", async () => {
    const fetch = vi.fn().mockResolvedValue(rateLimited("2"));
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      await expect(
        createSlackLookupClient("lookup-fixture", { fetch: fetch as never }).auth.test(),
      ).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(timer).not.toHaveBeenCalledWith(expect.any(Function), 2000);
    } finally {
      timer.mockRestore();
    }
  });

  it("keeps dropped upload completions one-shot, authenticated and team-scoped", async () => {
    await withListener(
      "drop",
      async ({ requests }, listener, options) => {
        const client = requireWriter(listener, options);
        expect(writer(listener, options)).toBe(client);
        expect(writer(listener, options, "TENTERPRISE2")).toBeUndefined();
        await expect(upload(client)).rejects.toThrow();
        expect(requests).toMatchObject([
          {
            authorization: "Bearer listener-fixture",
            method: "POST",
            url: "/api/files.completeUploadExternal",
          },
        ]);
        expect(new URLSearchParams(requests[0]?.body).get("team_id")).toBe("TENTERPRISE1");
      },
      { headers: { Authorization: "Bearer stale-fixture", "X-Slack-Test": "preserved" } },
    );
  });

  it("does not inherit the listener request timeout for upload completion", async () => {
    await withListener(
      80,
      async ({ requests }, listener, options) => {
        await expect(upload(requireWriter(listener, options))).resolves.toMatchObject({ ok: true });
        expect(requests).toHaveLength(1);
      },
      { timeout: 20 },
    );
  });

  it("bounds dedicated reads without timing out shared clients", async () => {
    await withApi(80, async ({ requests, options }) => {
      const config = { ...options, retryConfig: { retries: 0 } };
      await expect(
        createSlackReadClient("xoxb-read", { ...config, timeout: 20 }).auth.test(),
      ).rejects.toThrow();
      await expect(createSlackWebClient("xoxb-shared", config).auth.test()).resolves.toMatchObject({
        ok: true,
      });
      // The timed-out read may never arrive; only the shared client's arrival is certain.
      expect(requests.length).toBeGreaterThanOrEqual(1);
      expect(requests.at(-1)?.authorization).toBe("Bearer xoxb-shared");
    });
  });
});
