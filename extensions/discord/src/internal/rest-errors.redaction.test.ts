import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  DiscordError,
  isUnknownDiscordVoiceStateError,
  RateLimitError,
  RequestClient,
} from "./rest.js";

async function captureError<T extends DiscordError>(
  promise: Promise<unknown>,
  type: abstract new (...args: never[]) => T,
): Promise<T> {
  await expect(promise).rejects.toBeInstanceOf(type);
  const error = await promise.catch((caught: unknown) => caught);
  return error as T;
}

const token = ["MTAxMjM0NTY3ODkwMTIzNDU2", "discord", "credential", "fixture"].join(".");
function expectRedactedDetails(error: DiscordError, safe?: string) {
  const details = JSON.stringify({
    message: error.message,
    rawBody: error.rawBody,
  });
  expect(details).not.toContain(token);
  expect(details).not.toContain(`Bot ${token}`);
  expect(details).not.toContain("discord.credential");
  if (safe) {
    expect(details).toContain(safe);
  }
  return details;
}

function errorBody(body: unknown) {
  return new DiscordError(new Response(null, { status: 500 }), body);
}

describe("Discord REST error redaction", () => {
  it("redacts reflected credentials while preserving Discord error metadata", async () => {
    const server = createServer((req, res) => {
      const authorization = req.headers.authorization;
      if (!authorization) {
        res.writeHead(500).end();
        return;
      }
      const endpoint = req.url?.split("/").at(-1);
      if (endpoint === "plain-text") {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(`Proxy rejected request; Authorization: ${authorization}`);
        return;
      }
      const isSuccess = endpoint === "success";
      const reflected = endpoint === "rate-limit-reflected-headers";
      const isRateLimit = reflected || endpoint === "rate-limit";
      const responseBody = isSuccess
        ? { ok: true, safe: "success diagnostic" }
        : isRateLimit
          ? {
              message: `Rate limited; Authorization: ${authorization}`,
              retry_after: 0.25,
              global: false,
              code: 20_028,
            }
          : {
              message: `Voice request rejected; Authorization: ${authorization}`,
              code: 10_065,
              request: {
                headers: { authorization },
                numericAuthorization: { authorization: 812_345_678_901_234 },
                nestedAuthorization: {
                  authorization: { value: authorization, [token]: "rejected token key" },
                },
                reflectedKeys: { [`Authorization: ${authorization}`]: "rejected" },
                url: `https://discord.example/callback?token=${token}`,
              },
              safe: "voice diagnostic",
            };
      res.writeHead(isSuccess ? 200 : isRateLimit ? 429 : 401, {
        "Content-Type": "application/json",
        "X-RateLimit-Bucket": reflected ? authorization : "test-bucket",
        "X-RateLimit-Scope": reflected ? authorization : "user",
      });
      res.end(JSON.stringify(responseBody));
    });
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind to a TCP port");
      }
      const client = new RequestClient(token, {
        baseUrl: `http://127.0.0.1:${address.port}`,
        queueRequests: false,
      });

      const discordError = await captureError(client.get("/voice-state"), DiscordError);
      const voiceDetails = expectRedactedDetails(discordError, "voice diagnostic");
      expect(voiceDetails).not.toContain("812345678901234");
      expect(discordError.discordCode).toBe(10_065);
      expect(isUnknownDiscordVoiceStateError(discordError)).toBe(true);

      const webhookRateLimitPath = `/webhooks/app/${token}/rate-limit`;
      const rateLimitError = await captureError(client.get(webhookRateLimitPath), RateLimitError);
      expectRedactedDetails(rateLimitError);
      expect(rateLimitError).toMatchObject({
        retryAfter: 0.25,
        discordCode: 20_028,
        scope: "user",
      });

      const { scheduler } = client as unknown as { scheduler: { buckets: Map<string, unknown> } };
      const bucketCount = scheduler.buckets.size;
      expect(bucketCount).toBeGreaterThan(0);
      expect([...scheduler.buckets.keys()]).toEqual(
        expect.arrayContaining([expect.stringMatching(/sha256:[a-f0-9]{32}/)]),
      );
      await captureError(client.get(webhookRateLimitPath), RateLimitError);
      expect(scheduler.buckets.size).toBe(bucketCount);
      expect(JSON.stringify([...scheduler.buckets])).not.toContain(token);

      const reflectedRateLimitError = await captureError(
        client.get("/rate-limit-reflected-headers"),
        RateLimitError,
      );
      const reflectedHeaderDetails = JSON.stringify({
        scope: reflectedRateLimitError.scope,
        scheduler: [...scheduler.buckets],
      });
      expect(reflectedHeaderDetails).not.toContain(token);
      expect(reflectedHeaderDetails).not.toContain("discord.credential");
      expect(reflectedRateLimitError.scope).toBeNull();

      const textError = await captureError(client.get("/plain-text"), DiscordError);
      expectRedactedDetails(textError, "Proxy rejected request");

      await expect(client.get("/success")).resolves.toEqual({
        ok: true,
        safe: "success diagnostic",
      });
    } finally {
      await promisify(server.close.bind(server))();
    }
  });

  it("bounds recursive Discord error-body redaction", () => {
    const circular: { message: string; self?: unknown } = { message: "safe diagnostic" };
    circular.self = circular;
    const circularError = errorBody(circular);
    expect((circularError.rawBody as { self?: unknown }).self).toBe("[Circular]");

    const nestedToken = "MTAxMjM0NTY3ODkwMTIzNDU2.deeply.nested.credential";
    let nested: unknown = { authorization: nestedToken };
    for (let depth = 0; depth < 70; depth += 1) {
      nested = { child: nested };
    }
    const deepError = errorBody({
      message: "safe diagnostic",
      nested,
    });
    const deepDetails = JSON.stringify(deepError.rawBody);
    expect(deepDetails).not.toContain(nestedToken);
    expect(deepDetails).toContain("[Discord error body redacted: maximum depth exceeded]");
  });

  it("redacts reflected credentials inside Discord validation arrays", () => {
    const validationToken = "MTAxMjM0NTY3ODkwMTIzNDU2.validation.array.credential";
    const error = new DiscordError(new Response(null, { status: 400 }), {
      message: "Invalid Form Body",
      errors: {
        content: {
          _errors: [
            {
              code: "BASE_TYPE_BAD_LENGTH",
              message: `Authorization: Bot ${validationToken}`,
            },
          ],
        },
      },
    });
    const details = JSON.stringify(error.rawBody);

    expect(details).not.toContain(validationToken);
    expect(details).toContain("BASE_TYPE_BAD_LENGTH");
    expect(details).toContain("Invalid Form Body");
  });

  it("redacts low-entropy values solely from their sensitive field key", () => {
    const error = new DiscordError(new Response(null, { status: 400 }), {
      message: "Invalid Form Body",
      authorization: {
        note: "plain fixture",
        attempt: 42,
      },
    });

    expect(error.rawBody).toEqual({
      message: "Invalid Form Body",
      authorization: { "***": "***", "*** [2]": "***" },
    });
  });

  it("marks a priority-only object that exhausts the redaction node budget", () => {
    const marker = "[Discord error body redacted: node limit exceeded]";
    const body = [...Array.from({ length: 9_998 }, () => null), { message: "truncated" }];
    const error = errorBody(body);
    const redactedBody = error.rawBody as unknown[];

    expect(redactedBody).toHaveLength(9_999);
    expect(redactedBody.at(-1)).toEqual({ [marker]: marker });
  });

  it("bounds wide Discord error-body redaction", () => {
    const fields = Object.fromEntries(
      Array.from({ length: 10_050 }, (_, index) => [`field-${index}`, index]),
    );
    const error = errorBody({
      fields,
      message: "wide diagnostic",
      code: 10_065,
    });

    expect(JSON.stringify(error.rawBody)).toContain(
      "[Discord error body redacted: node limit exceeded]",
    );
    expect(error.rawBody).toMatchObject({ message: "wide diagnostic", code: 10_065 });
    expect(error).toMatchObject({ message: "wide diagnostic", discordCode: 10_065 });
  });
});
