// Real monitor delivery, OAuth and HTTP; only ingress/routing and the chunker are simulated.
import { generateKeyPairSync } from "node:crypto";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type {
  GoogleChatCoreRuntime,
  GoogleChatRuntimeEnv,
  WebhookTarget,
} from "./monitor-types.js";
import { createGoogleChatReplyDeliveryHarness } from "./monitor.reply-delivery.test-support.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const account = {
  accountId: "default",
  enabled: true,
  credentialSource: "inline",
  credentials: {
    type: "service_account",
    client_email: "stub-bot@stub-project.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  },
  config: {},
} as unknown as ResolvedGoogleChatAccount;

const config = {} as OpenClawConfig;

const CHUNKS = [
  "First chunk of the assistant reply.",
  "Second chunk of the assistant reply.",
  "Third chunk of the assistant reply.",
] as const;

const harness = createGoogleChatReplyDeliveryHarness();
const core = {
  ...harness.core,
  channel: {
    ...harness.core.channel,
    text: {
      resolveChunkMode: () => "markdown",
      chunkMarkdownTextWithMode: () => CHUNKS,
    },
  },
} as unknown as GoogleChatCoreRuntime;

type CreateAttempt = { text?: string; status: number };

function createStubHandler(params: { failCreateIndexes: Set<number>; patchStatus?: number }) {
  const createAttempts: CreateAttempt[] = [];
  const patchAttempts: string[] = [];
  const handler = (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://stub.invalid");
      const json = (status: number, payload: unknown) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && url.pathname === "/token") {
        json(200, { access_token: "ya29.stub-token", token_type: "Bearer", expires_in: 3600 });
        return;
      }
      const messagesMatch = url.pathname.match(/^\/v1\/(spaces\/[^/]+)\/messages$/);
      if (req.method === "POST" && messagesMatch) {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text?: string };
        // Ingress preparation is not one of the reply attempts under test.
        if (body.text === "_OpenClaw is typing..._") {
          json(200, {
            name: `${messagesMatch[1]}/messages/typing`,
            thread: { name: `${messagesMatch[1]}/threads/root` },
          });
          return;
        }
        const index = createAttempts.length + 1;
        const status = params.failCreateIndexes.has(index) ? 500 : 200;
        createAttempts.push({ text: body.text, status });
        if (status === 500) {
          json(500, {
            error: { code: 500, message: "stub: backend unavailable", status: "INTERNAL" },
          });
        } else {
          json(200, { name: `${messagesMatch[1]}/messages/stub-m${index}` });
        }
        return;
      }
      const messageMatch = url.pathname.match(/^\/v1\/(spaces\/[^/]+\/messages\/[^/]+)$/);
      if (req.method === "PATCH" && messageMatch?.[1]) {
        patchAttempts.push(messageMatch[1]);
        const status = params.patchStatus ?? 200;
        json(
          status,
          status === 200
            ? { name: messageMatch[1] }
            : { error: { code: status, message: "stub: message not found", status: "NOT_FOUND" } },
        );
        return;
      }
      json(400, { error: { code: 400, message: "stub: unhandled request" } });
    });
  };
  return { handler, createAttempts, patchAttempts };
}

function stubGoogleHostsFetch() {
  const realFetch = globalThis.fetch;
  let stubBaseUrl: string | undefined;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl);
    if (url.hostname === "chat.googleapis.com" || url.hostname === "oauth2.googleapis.com") {
      if (!stubBaseUrl) {
        throw new Error("stub server base URL not installed");
      }
      return await realFetch(`${stubBaseUrl}${url.pathname}${url.search}`, init);
    }
    return await realFetch(input, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    pointAtStub: (baseUrl: string) => {
      stubBaseUrl = baseUrl;
    },
  };
}

async function runDelivery(
  params: {
    withTypingMessage?: boolean;
    statusSink?: WebhookTarget["statusSink"];
  },
  fetchControl: ReturnType<typeof stubGoogleHostsFetch>,
) {
  const errorLines: string[] = [];
  const runtime: GoogleChatRuntimeEnv = {
    error: (line: string) => {
      errorLines.push(line);
    },
  };
  let deliveryFetchStart = 0;
  try {
    await harness.process(
      {
        account: {
          ...account,
          config: {
            replyToMode: "all",
            typingIndicator: params.withTypingMessage ? "message" : "none",
          },
        },
        runtime,
        core,
        config,
        statusSink: params.statusSink,
      },
      async (delivery) => {
        deliveryFetchStart = fetchControl.fetchMock.mock.calls.length;
        await delivery.deliver(
          { text: CHUNKS.join("\n\n"), replyToId: "spaces/AAA/threads/root" },
          { kind: "final" },
        );
      },
    );
    return { outcome: "delivered", deliverError: undefined, errorLines, deliveryFetchStart };
  } catch (err) {
    return {
      outcome: "failed-deliver",
      deliverError: err,
      errorLines,
      deliveryFetchStart,
    };
  }
}

async function runFixture(
  failCreateIndexes: number[] = [],
  patchStatus?: number,
  delivery: Parameters<typeof runDelivery>[0] = {},
) {
  const stub = createStubHandler({ failCreateIndexes: new Set(failCreateIndexes), patchStatus });
  const fetchControl = stubGoogleHostsFetch();
  const result = Promise.withResolvers<Awaited<ReturnType<typeof runDelivery>>>();
  await withServer(stub.handler, async (baseUrl) => {
    fetchControl.pointAtStub(baseUrl);
    result.resolve(await runDelivery(delivery, fetchControl));
  });
  return { ...stub, ...(await result.promise), fetchControl };
}

function expectPartialDelivery(
  error: unknown,
  deliveryResult: { messageIds: string[]; content: string; visibleReplySent: true },
) {
  expect(isChannelPartialDeliveryError(error)).toBe(true);
  if (!isChannelPartialDeliveryError(error)) {
    throw new Error("expected partial delivery error");
  }
  expect(error.deliveryResult).toEqual(deliveryResult);
}

describe("Google Chat reply delivery failure propagation (integration)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces a failed non-first chunk send as a dispatcher-visible delivery failure", async () => {
    const result = await runFixture([2]);

    expect(result.outcome).toBe("failed-deliver");
    expect(result.deliverError).toBeInstanceOf(Error);
    expect((result.deliverError as Error).message).toContain("Google Chat API 500");
    expect((result.deliverError as Error).message).toContain("stub: backend unavailable");
    expectPartialDelivery(result.deliverError, {
      messageIds: ["spaces/AAA/messages/stub-m1"],
      content: CHUNKS[0],
      visibleReplySent: true,
    });
    // The failing create rejects the whole delivery: the third chunk is never attempted.
    expect(result.createAttempts).toEqual([
      { status: 200, text: CHUNKS[0] },
      { status: 500, text: CHUNKS[1] },
    ]);
    // Both Google hosts went through the production fetch path.
    const requestedUrls = result.fetchControl.fetchMock.mock.calls.map((call) => {
      const input = call[0] as RequestInfo | URL;
      return input instanceof Request ? input.url : String(input);
    });
    expect(requestedUrls.some((url) => url.startsWith("https://oauth2.googleapis.com/"))).toBe(
      true,
    );
    expect(
      requestedUrls
        .slice(result.deliveryFetchStart)
        .filter((url) => url.startsWith("https://chat.googleapis.com/")),
    ).toHaveLength(2);
  });

  it("preserves a successful typing-placeholder update when a later create fails", async () => {
    const result = await runFixture([1], undefined, { withTypingMessage: true });

    expect(result.outcome).toBe("failed-deliver");
    expectPartialDelivery(result.deliverError, {
      messageIds: ["spaces/AAA/messages/typing"],
      content: CHUNKS[0],
      visibleReplySent: true,
    });
    expect(result.patchAttempts).toEqual(["spaces/AAA/messages/typing"]);
    expect(result.createAttempts.map((attempt) => attempt.status)).toEqual([500]);
  });

  it("rejects when the resend after a typing-placeholder update failure also fails", async () => {
    const result = await runFixture([1], 404, { withTypingMessage: true });

    expect(result.outcome).toBe("failed-deliver");
    expect(isChannelPartialDeliveryError(result.deliverError)).toBe(false);
    expect((result.deliverError as Error).message).toContain("Google Chat API 500");
    expect(result.patchAttempts).toEqual(["spaces/AAA/messages/typing"]);
    expect(result.createAttempts.map((attempt) => attempt.status)).toEqual([500]);
    // The recoverable placeholder failure stays logged, not fatal; only the
    // resend failure becomes the delivery error.
    expect(result.errorLines.some((line) => line.includes("Google Chat API 404"))).toBe(true);
  });

  it("recovers from a missing typing placeholder without duplicating any chunk", async () => {
    const result = await runFixture([], 404, { withTypingMessage: true });

    expect(result.outcome).toBe("delivered");
    expect(result.patchAttempts).toEqual(["spaces/AAA/messages/typing"]);
    expect(result.createAttempts).toEqual(CHUNKS.map((text) => ({ text, status: 200 })));
    expect(result.errorLines.some((line) => line.includes("Google Chat API 404"))).toBe(true);
  });

  it("does not resend a delivered chunk when outbound status reporting fails", async () => {
    const statusSink = vi.fn(() => {
      throw new Error("status unavailable");
    });
    const result = await runFixture([], undefined, { withTypingMessage: true, statusSink });

    expect(result.outcome).toBe("delivered");
    expect(result.patchAttempts).toEqual(["spaces/AAA/messages/typing"]);
    expect(result.createAttempts).toEqual(CHUNKS.slice(1).map((text) => ({ text, status: 200 })));
    expect(statusSink).toHaveBeenCalledTimes(CHUNKS.length);
    expect(result.errorLines).toEqual(
      Array(CHUNKS.length).fill(
        "Google Chat outbound status update failed: Error: status unavailable",
      ),
    );
  });
});
