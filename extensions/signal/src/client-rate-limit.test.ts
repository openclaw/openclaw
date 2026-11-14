import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signalRpcRequest } from "./client.js";
import { useSignalHttpServer } from "./client.test-support.js";

vi.mock("openclaw/plugin-sdk/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/core")>()),
  generateSecureUuid: () => "test-id",
}));

const withSignalServer = useSignalHttpServer();
const rpc = (baseUrl: string, options: Partial<Parameters<typeof signalRpcRequest>[2]> = {}) =>
  signalRpcRequest("version", undefined, { baseUrl, ...options });
const reply = (body: string | Buffer, status = 200) =>
  withSignalServer((_req, res) => {
    res.writeHead(status);
    res.end(body);
  });

afterEach(() => vi.restoreAllMocks());

describe("signalRpcRequest", () => {
  it.each([
    [
      "rate-limited without retry time",
      {
        code: -5,
        message: "Failed to send message due to rate limiting",
        data: {
          response: {
            results: [{ type: "RATE_LIMIT_FAILURE", account: "+15550000001" }],
          },
        },
      },
      "Signal RPC -5: Failed to send message due to rate limiting",
    ],
    [
      "rate-limited with retry time",
      {
        code: -5,
        message: "Failed to send message due to rate limiting",
        data: {
          response: {
            results: [
              { type: "RATE_LIMIT_FAILURE", retryAfterSeconds: 7, account: "+15550000001" },
              { type: "RATE_LIMIT_FAILURE", retryAfterSeconds: 12, account: "+15550000002" },
            ],
          },
        },
      },
      "Signal RPC -5: Failed to send message due to rate limiting (wait 12s to retry)",
    ],
    [
      "captcha challenge required",
      {
        code: -5,
        message: "Failed to send message due to rate limiting",
        data: {
          response: {
            results: [
              {
                type: "RATE_LIMIT_FAILURE",
                retryAfterSeconds: 60,
                token: "proof-token",
                account: "+15550000001",
              },
            ],
          },
        },
      },
      "Signal RPC -5: Failed to send message due to rate limiting (wait 60s to retry; captcha challenge required; solve one at https://signalcaptchas.org/challenge/generate.html and run `signal-cli submitRateLimitChallenge --challenge <token> --captcha <result>` to recover)",
    ],
    [
      "other error codes keep their message unchanged",
      {
        code: -32000,
        message: "Bad request",
        data: { response: { results: [{ type: "RATE_LIMIT_FAILURE", retryAfterSeconds: 5 }] } },
      },
      "Signal RPC -32000: Bad request",
    ],
  ] as const)(
    "surfaces rate-limit/captcha recovery facts for %s (HTTP)",
    async (_name, error, message) => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: "test-id", error });
      const result = rpc(await reply(body));
      await expect(result).rejects.toMatchObject({ message });
    },
  );
});
