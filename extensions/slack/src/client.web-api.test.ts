import { WebClient, type WebClientOptions } from "@slack/web-api";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSlackLookupClient,
  createSlackReadClient,
  createSlackStartupAuthClient,
  createSlackWebClient,
  getSlackListenerWriteClient,
} from "./client.js";
import { startSlackStream } from "./streaming.js";

const TEST_ENV_KEYS = [
  "SLACK_API_URL",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "OPENCLAW_PROXY_ACTIVE",
  "OPENCLAW_PROXY_CA_FILE",
] as const;

type SlackApiRequest = {
  authorization?: string;
  body?: string;
  method?: string;
  url?: string;
};

beforeEach(() => {
  for (const key of TEST_ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
});

async function withSlackApiServer(
  requests: SlackApiRequest[],
  mode: number | "drop" | "stall",
  use: (baseUrl: string, socketClosed: Promise<void>) => Promise<void>,
) {
  const { promise: socketClosed, resolve: resolveSocketClosed } = Promise.withResolvers<void>();
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
      request.socket.once("close", resolveSocketClosed);
      if (mode === "drop") {
        request.once("end", () => request.socket.destroy());
      } else if (mode !== "stall") {
        const sendResponse = () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
        };
        if (mode > 0) {
          setTimeout(sendResponse, mode);
        } else {
          sendResponse();
        }
      }
    },
    async (baseUrl) => use(baseUrl, socketClosed),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const authResult = { ok: true, team_id: "TMOCK", user_id: "UMOCK" };
const authResponse = () => new Response(JSON.stringify(authResult), { status: 200 });
const rateLimited = (seconds: string) =>
  new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
    status: 429,
    headers: { "retry-after": seconds },
  });
const upload = (client: WebClient) =>
  client.files.completeUploadExternal({
    files: [{ id: "F123", title: "proof.txt" }],
    channel_id: "C123",
  });
function requireWriteClient(listenerClient: WebClient, clientOptions: WebClientOptions) {
  const client = getSlackListenerWriteClient({
    listenerClient,
    clientOptions,
    teamId: "TENTERPRISE1",
  });
  expect(client).toBeDefined();
  if (!client) {
    throw new Error("missing Enterprise upload completion client");
  }
  return client;
}

describe("Slack Web API routing", () => {
  it("keeps lost stream responses one-shot without changing listener reads", async () => {
    const teamId = "TENTERPRISE1";
    const requests: SlackApiRequest[] = [];
    await withSlackApiServer(requests, "drop", async (baseUrl) => {
      const clientOptions = {
        slackApiUrl: `${baseUrl}/api/`,
        teamId,
        retryConfig: { retries: 2, minTimeout: 1, maxTimeout: 1 },
      };
      const listenerClient = new WebClient("listener-stream-fixture", clientOptions);

      await expect(
        startSlackStream({
          client: listenerClient,
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
        authorization: "Bearer listener-stream-fixture",
        url: "/api/chat.startStream",
      });
      const payload = new URLSearchParams(requests[0]?.body);
      expect(payload.get("team_id")).toBe(teamId ?? null);
      expect(payload.get("recipient_team_id")).toBe("TRECIPIENT");

      await expect(listenerClient.auth.test()).rejects.toThrow();
      expect(requests.filter((request) => request.url === "/api/auth.test")).toHaveLength(3);
    });
  });

  it("retries two transient startup auth failures", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("request timed out"))
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(authResponse());
    const client = createSlackStartupAuthClient("startup-fixture", { fetch: fetchMock as never });

    await expect(client.auth.test()).resolves.toMatchObject(authResult);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries startup auth after a rate limit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimited("0"))
      .mockResolvedValueOnce(authResponse());
    const client = createSlackStartupAuthClient("rate-limited-fixture", {
      fetch: fetchMock as never,
    });

    await expect(client.auth.test()).resolves.toMatchObject(authResult);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts a stalled-header lookup after one request", async () => {
    const requests: SlackApiRequest[] = [];
    await withSlackApiServer(requests, "stall", async (baseUrl, socketClosed) => {
      const client = createSlackLookupClient("lookup-fixture", {
        slackApiUrl: `${baseUrl}/api/`,
        timeout: 50,
      });

      await expect(client.auth.test()).rejects.toThrow();
      await socketClosed;

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: "POST", url: "/api/auth.test" });
    });
  });

  it("rejects rate limits without sleeping through Retry-After", async () => {
    const fetchMock = vi.fn().mockResolvedValue(rateLimited("2"));
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const client = createSlackLookupClient("lookup-fixture", { fetch: fetchMock as never });

      await expect(client.auth.test()).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(timeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 2000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("keeps dropped Enterprise upload completion responses to one team-scoped request", async () => {
    const requests: SlackApiRequest[] = [];
    await withSlackApiServer(requests, "drop", async (baseUrl) => {
      const clientOptions = {
        headers: { Authorization: "Bearer stale-fixture", "X-Slack-Test": "preserved" },
        slackApiUrl: `${baseUrl}/api/`,
        retryConfig: { retries: 2 },
      };
      const listenerClient = new WebClient("listener-fixture", clientOptions);
      const completionClient = requireWriteClient(listenerClient, clientOptions);
      expect(
        getSlackListenerWriteClient({ listenerClient, teamId: "TENTERPRISE1", clientOptions }),
      ).toBe(completionClient);
      expect(
        getSlackListenerWriteClient({ listenerClient, teamId: "TENTERPRISE2", clientOptions }),
      ).toBeUndefined();

      await expect(upload(completionClient)).rejects.toThrow();

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        authorization: "Bearer listener-fixture",
        method: "POST",
        url: "/api/files.completeUploadExternal",
      });
      expect(new URLSearchParams(requests[0]?.body).get("team_id")).toBe("TENTERPRISE1");
      expect(requests[0]?.authorization).not.toContain("stale-fixture");
    });
  });

  it("does not inherit the listener request timeout for upload completion", async () => {
    const requests: SlackApiRequest[] = [];
    await withSlackApiServer(requests, 80, async (baseUrl) => {
      const clientOptions = {
        slackApiUrl: `${baseUrl}/api/`,
        retryConfig: { retries: 2 },
        timeout: 20,
      };
      const listenerClient = new WebClient("listener-fixture", clientOptions);
      const result = await upload(requireWriteClient(listenerClient, clientOptions));

      expect(result.ok).toBe(true);
      expect(requests).toHaveLength(1);
    });
  });

  it("bounds dedicated reads without timing out shared clients", async () => {
    const requests: SlackApiRequest[] = [];
    await withSlackApiServer(requests, 80, async (baseUrl) => {
      const options = { retryConfig: { retries: 0 }, slackApiUrl: `${baseUrl}/api/` };
      const readClient = createSlackReadClient("xoxb-read", { ...options, timeout: 20 });
      const sharedClient = createSlackWebClient("xoxb-shared", options);

      await expect(readClient.auth.test()).rejects.toThrow();
      await expect(sharedClient.auth.test()).resolves.toMatchObject({ ok: true });

      // The timed-out read may never arrive; only the shared client's arrival is certain.
      expect(requests.length).toBeGreaterThanOrEqual(1);
      expect(requests.at(-1)?.authorization).toBe("Bearer xoxb-shared");
    });
  });
});
