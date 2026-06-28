// Slack tests cover real Web API routing behavior.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createSlackWebClient } from "./client.js";

const SLACK_API_URL_KEYS = ["SLACK_API_URL"] as const;
const PROXY_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "OPENCLAW_PROXY_ACTIVE",
  "OPENCLAW_PROXY_CA_FILE",
] as const;
const TEST_ENV_KEYS = [...SLACK_API_URL_KEYS, ...PROXY_KEYS] as const;
const originalEnv = { ...process.env };

type SlackApiRequest = {
  authorization?: string;
  method?: string;
  url?: string;
};

function restoreTestEnv() {
  for (const key of TEST_ENV_KEYS) {
    if (originalEnv[key] !== undefined) {
      process.env[key] = originalEnv[key];
    } else {
      delete process.env[key];
    }
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function startSlackApiServer(requests: SlackApiRequest[]): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    requests.push({
      authorization: request.headers.authorization,
      method: request.method,
      url: request.url,
    });
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      `${JSON.stringify({
        ok: true,
        team: "Mock Slack",
        team_id: "TMOCK",
        url: "https://mock.slack.test/",
        user: "mock-bot",
        user_id: "UMOCK",
      })}\n`,
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

afterEach(() => {
  restoreTestEnv();
});

describe("Slack Web API routing", () => {
  it("routes real WebClient requests to the SLACK_API_URL root", async () => {
    for (const key of TEST_ENV_KEYS) {
      delete process.env[key];
    }
    const requests: SlackApiRequest[] = [];
    const server = await startSlackApiServer(requests);
    try {
      process.env.SLACK_API_URL = `${server.baseUrl}/api/`;

      const client = createSlackWebClient("xoxb-route-proof", {
        retryConfig: { retries: 0 },
        timeout: 1000,
      });
      const result = await client.auth.test();

      expect(result.ok).toBe(true);
      expect(requests).toEqual([
        {
          authorization: "Bearer xoxb-route-proof",
          method: "POST",
          url: "/api/auth.test",
        },
      ]);
    } finally {
      await server.close();
    }
  });
});
