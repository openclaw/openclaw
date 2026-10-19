import { createServer } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import {
  downloadGoogleChatMedia,
  GoogleChatApiError,
  sendGoogleChatMessage,
  updateGoogleChatMessage,
} from "./api.js";
import {
  registerGoogleChatManualApprovalFollowupSuppression,
  unregisterGoogleChatManualApprovalFollowupSuppression,
} from "./approval-card-actions.js";
import { isGoogleChatGroupSpace, resolveGoogleChatOutboundSessionRoute } from "./targets.js";

const mocks = vi.hoisted(() => ({
  buildHostnameAllowlistPolicyFromSuffixAllowlist: vi.fn((hosts: string[]) => ({
    hostnameAllowlist: hosts,
  })),
  fetchWithSsrFGuard: vi.fn(
    async (params: { url: string; init?: RequestInit; timeoutMs?: number }) => ({
      response: await fetch(params.url, params.init),
      release: async () => {},
    }),
  ),
  googleAuthCtor: vi.fn(),
  gaxiosCtor: vi.fn(),
  getAccessToken: vi.fn().mockResolvedValue({ token: "access-token" }),
  oauthCtor: vi.fn(),
  verifySignedJwtWithCertsAsync: vi.fn(),
  verifyIdToken: vi.fn(),
  getGoogleChatAccessToken: vi.fn().mockResolvedValue("token"),
}));

// mock-isolation: Exercise Google Chat response handling with controlled local HTTP, not DNS policy.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  buildHostnameAllowlistPolicyFromSuffixAllowlist:
    mocks.buildHostnameAllowlistPolicyFromSuffixAllowlist,
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

vi.mock("google-auth-library", () => ({
  gaxios: {
    Gaxios: class {
      defaults: unknown;
      interceptors = {
        request: { add: vi.fn() },
        response: { add: vi.fn() },
      };

      constructor(defaults?: unknown) {
        this.defaults = defaults;
        mocks.gaxiosCtor(defaults);
      }
    },
  },
  GoogleAuth: class {
    constructor(options?: unknown) {
      mocks.googleAuthCtor(options);
    }

    getClient = vi.fn().mockResolvedValue({ getAccessToken: mocks.getAccessToken });
  },
  OAuth2Client: class {
    constructor(options?: unknown) {
      mocks.oauthCtor(options);
    }

    verifyIdToken = mocks.verifyIdToken;
    verifySignedJwtWithCertsAsync = mocks.verifySignedJwtWithCertsAsync;
  },
}));

vi.mock("./auth.js", async () => {
  const actual = await vi.importActual<typeof import("./auth.js")>("./auth.js");
  return {
    ...actual,
    getGoogleChatAccessToken: mocks.getGoogleChatAccessToken,
  };
});

const { getGoogleChatAccessToken, verifyGoogleChatRequest } =
  await vi.importActual<typeof import("./auth.js")>("./auth.js");

let googleChatCertFetchNowMs = Date.now();

function expireGoogleChatCertCache(): void {
  googleChatCertFetchNowMs += 11 * 60 * 1000;
  vi.spyOn(Date, "now").mockReturnValue(googleChatCertFetchNowMs);
}

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.doUnmock("google-auth-library");
  vi.doUnmock("./auth.js");
  vi.resetModules();
});

let accountCounter = 0;
let account = {
  accountId: "test-0",
  enabled: true,
  credentialSource: "inline",
  config: {},
} as ResolvedGoogleChatAccount;

beforeEach(() => {
  accountCounter += 1;
  account = { ...account, accountId: `test-${accountCounter}` };
});

afterEach(() => {
  mocks.fetchWithSsrFGuard.mockClear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200 });
}

function stubResponse(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function guardedResponse(response: Response) {
  const release = vi.fn(async () => {});
  mocks.fetchWithSsrFGuard.mockResolvedValueOnce({ response, release });
  return release;
}

function stubSuccessfulSend(name: string, threadName?: string) {
  return stubResponse(
    jsonResponse({ name, ...(threadName ? { thread: { name: threadName } } : {}) }),
  );
}

function send(overrides: Partial<Parameters<typeof sendGoogleChatMessage>[0]> = {}) {
  return sendGoogleChatMessage({ account, space: "spaces/AAA", text: "hello", ...overrides });
}

function download(maxBytes: number | undefined = 10) {
  return downloadGoogleChatMedia({ account, resourceName: "media/123", maxBytes });
}

function sessionRoute(target = "spaces/AAA") {
  return resolveGoogleChatOutboundSessionRoute({ cfg: {}, agentId: "main", target });
}

function verifyAppToken(expectedAddOnPrincipal?: string) {
  return verifyGoogleChatRequest({
    bearer: "token",
    audienceType: "app-url",
    audience: "https://example.com/googlechat",
    expectedAddOnPrincipal,
  });
}

function verifyProjectToken() {
  return verifyGoogleChatRequest({
    bearer: "token",
    audienceType: "project-number",
    audience: "123456789",
  });
}

function requestBody(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = mockCallArg(mock, 0, 1) as RequestInit | undefined;
  if (typeof init?.body !== "string") {
    throw new Error("Expected Google Chat request body");
  }
  return JSON.parse(init.body);
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

it("classifies current and legacy space metadata through the group boundary", () => {
  expect(isGoogleChatGroupSpace({ spaceType: "DIRECT_MESSAGE", type: "ROOM" })).toBe(false);
  expect(isGoogleChatGroupSpace({ spaceType: "SPACE", type: "DM" })).toBe(true);
  expect(isGoogleChatGroupSpace({ singleUserBotDm: true })).toBe(false);
  expect(isGoogleChatGroupSpace({ type: "ROOM" })).toBe(true);
  expect(isGoogleChatGroupSpace({})).toBe(true);
});
describe("outbound session routing", () => {
  it("classifies API space type SPACE", async () => {
    const fetchMock = stubResponse(jsonResponse({ name: "spaces/AAA", spaceType: "SPACE" }));
    const route = await sessionRoute("googlechat:spaces/AAA");

    expect(route).toMatchObject({
      peer: { kind: "group", id: "spaces/AAA" },
      chatType: "group",
      from: "googlechat:spaces/AAA",
      to: "spaces/AAA",
    });
    expect(fetchMock).toHaveBeenCalledWith("https://chat.googleapis.com/v1/spaces/AAA", {
      method: "GET",
      headers: {
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      },
    });
  });

  it("rejects an unclassified space response", async () => {
    stubResponse(jsonResponse({ name: "spaces/AAA" }));
    await expect(sessionRoute()).resolves.toBeNull();
  });

  it("keeps session-route classification failures non-fatal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("read unavailable")));

    await expect(sessionRoute()).resolves.toBeNull();
  });
});

describe("downloadGoogleChatMedia", () => {
  afterEach(() => {
    unregisterGoogleChatManualApprovalFollowupSuppression("12345678-1234-1234-1234-123456789012");
  });

  it("rejects content-length overflow before reading media", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({
        "content-length": "50",
      }),
      arrayBuffer,
    } as unknown as Response;

    stubResponse(response);
    await expect(download()).rejects.toThrow("Google Chat media exceeds max bytes (10)");
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(mocks.fetchWithSsrFGuard.mock.lastCall?.[0].timeoutMs).toBe(30_001);
  });

  it("cancels a stalled media error body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const release = guardedResponse(
      new Response(new ReadableStream({ start() {}, cancel }), { status: 500 }),
    );

    const pending = download();
    const result = expect(pending).rejects.toThrow(
      "Google Chat API error response stalled after 30000ms",
    );
    await vi.advanceTimersByTimeAsync(30_001);
    await result;
    await expect(pending).rejects.toBeInstanceOf(GoogleChatApiError);
    await expect(pending).rejects.toMatchObject({ status: 500 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("preserves redacted error-body read diagnostics", async () => {
    const token = "googlechat-error-read-test-token";
    const release = guardedResponse(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(`body read failed; Authorization: Bearer ${token}`));
          },
        }),
        { status: 500 },
      ),
    );

    const outcome = await download().catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(GoogleChatApiError);
    expect(outcome).toMatchObject({ status: 500 });
    expect((outcome as Error).message).toContain("Google Chat API 500: body read failed");
    expect((outcome as Error).message).not.toContain(token);
    expect(release).toHaveBeenCalledOnce();
  });

  it("bounds chunked endpoint media downloads even when callers omit maxBytes", async () => {
    const chunk = Buffer.alloc(1024 * 1024);
    const totalBytes = 32 * chunk.length;
    let bytesSent = 0;
    let responseClosed = false;
    let resolveResponseClosed: () => void = () => {};
    const responseClosedPromise = new Promise<void>((resolve) => {
      resolveResponseClosed = resolve;
    });
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.on("close", () => {
        responseClosed = true;
        resolveResponseClosed();
      });
      const writeNext = () => {
        if (responseClosed) {
          return;
        }
        if (bytesSent >= totalBytes) {
          res.end();
          return;
        }
        bytesSent += chunk.byteLength;
        const canContinue = res.write(chunk);
        const scheduleNext = () => setTimeout(writeNext, 1);
        if (canContinue) {
          scheduleNext();
        } else {
          res.once("drain", scheduleNext);
        }
      };
      writeNext();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected loopback media server address");
    }
    const mediaUrl = `http://127.0.0.1:${address.port}/media`;
    const release = vi.fn(async () => {});
    mocks.fetchWithSsrFGuard.mockImplementationOnce(async () => ({
      response: await fetch(mediaUrl),
      release,
    }));

    try {
      await expect(downloadGoogleChatMedia({ account, resourceName: "media/123" })).rejects.toThrow(
        "Google Chat media exceeds max bytes (20971520)",
      );
      await responseClosedPromise;
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    expect(release).toHaveBeenCalledOnce();
    expect(responseClosed).toBe(true);
    expect(bytesSent).toBeLessThan(totalBytes);
  });
});

it("cancels a stalled JSON response body", async () => {
  vi.useFakeTimers();
  stubResponse(new Response(new ReadableStream({ start() {} })));

  const result = expect(send()).rejects.toThrow(
    "Google Chat API request failed: response body stalled after 30000ms",
  );
  await vi.advanceTimersByTimeAsync(30_001);
  await result;
});
describe("sendGoogleChatMessage", () => {
  it("adds messageReplyOption when sending to an existing thread", async () => {
    const fetchMock = stubSuccessfulSend("spaces/AAA/messages/123", "spaces/AAA/threads/xyz");
    const cardsV2 = [{ cardId: "approval", card: { header: { title: "Approval" } } }];

    const result = await send({
      thread: "spaces/AAA/threads/xyz",
      cardsV2,
    });

    const url = mockCallArg(fetchMock);
    expect(String(url)).toContain("messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
    expect(requestBody(fetchMock)).toEqual({
      text: "hello",
      thread: { name: "spaces/AAA/threads/xyz" },
      cardsV2,
    });
    expect(result).toEqual({
      messageName: "spaces/AAA/messages/123",
      threadName: "spaces/AAA/threads/xyz",
    });
    expect(mocks.fetchWithSsrFGuard.mock.lastCall?.[0].timeoutMs).toBe(30_000);
  });

  it.each([
    ["a bare id", "113887189178345237288721356"],
    ["a thread from a different space", "spaces/BBB/threads/xyz"],
  ])(
    "drops an invalid thread resource name (%s) and posts to the space",
    async (_label, badThread) => {
      const fetchMock = stubSuccessfulSend("spaces/AAA/messages/126");

      const result = await send({ thread: badThread });

      const url = mockCallArg(fetchMock);
      // Omitting both fields avoids the Chat API's 400 INVALID_ARGUMENT.
      expect(String(url)).not.toContain("messageReplyOption=");
      expect(requestBody(fetchMock).thread).toBeUndefined();
      expect(result).toEqual({ messageName: "spaces/AAA/messages/126" });
    },
  );

  it("suppresses text-only duplicate manual approval follow-ups at the API send boundary", async () => {
    registerGoogleChatManualApprovalFollowupSuppression({
      approvalId: "12345678-1234-1234-1234-123456789012",
      approvalKind: "exec",
      allowedDecisions: ["allow-once", "deny"],
      expiresAtMs: Date.now() + 60_000,
    });

    const result = await send({
      text: "Please reply with:\n/approve 12345678 allow-once",
    });

    expect(result).toBeNull();
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });
});

it("updates text and cardsV2 with a matching update mask", async () => {
  const fetchMock = stubSuccessfulSend("spaces/AAA/messages/123");
  const cardsV2 = [{ cardId: "approval", card: { header: { title: "Resolved" } } }];

  await updateGoogleChatMessage({
    account,
    messageName: "spaces/AAA/messages/123",
    text: "Resolved",
    cardsV2,
  });

  expect(String(mockCallArg(fetchMock))).toContain(
    "spaces/AAA/messages/123?updateMask=text,cardsV2",
  );
  expect(requestBody(fetchMock)).toEqual({ text: "Resolved", cardsV2 });
});
function mockTicket(payload: Record<string, unknown>) {
  mocks.verifyIdToken.mockReset().mockResolvedValue({
    getPayload: () => payload,
  });
}

describe("verifyGoogleChatRequest", () => {
  afterEach(() => {
    mocks.getAccessToken.mockClear();
    mocks.gaxiosCtor.mockClear();
    mocks.googleAuthCtor.mockClear();
    mocks.oauthCtor.mockClear();
    vi.restoreAllMocks();
  });

  it("injects a scoped transporter into GoogleAuth access-token clients", async () => {
    await expect(
      getGoogleChatAccessToken({
        ...account,
        credentials: {
          client_email: "bot@example.iam.gserviceaccount.com",
          private_key: "key",
          token_uri: "https://oauth2.googleapis.com/token",
        },
      }),
    ).resolves.toBe("access-token");

    expect(mocks.gaxiosCtor).toHaveBeenCalledOnce();
    expect(mockCallArg(mocks.googleAuthCtor)).toMatchObject({
      credentials: {
        client_email: "bot@example.iam.gserviceaccount.com",
        token_uri: "https://oauth2.googleapis.com/token",
      },
      clientOptions: { transporter: { defaults: { fetchImplementation: expect.any(Function) } } },
    });
    expect(mocks.getAccessToken).toHaveBeenCalledOnce();
    expect("window" in globalThis).toBe(false);
  });

  it("accepts Google Chat app-url tokens from the Chat issuer", async () => {
    mockTicket({
      email: "chat@system.gserviceaccount.com",
      email_verified: true,
    });

    await expect(verifyAppToken()).resolves.toEqual({ ok: true });

    expect(mockCallArg(mocks.oauthCtor)).toMatchObject({
      transporter: { defaults: { fetchImplementation: expect.any(Function) } },
    });
  });

  it.each([
    [
      "missing binding",
      "principal-1",
      undefined,
      { ok: false, reason: "missing add-on principal binding" },
    ],
    ["matching binding", "principal-1", "principal-1", { ok: true }],
    [
      "mismatched binding",
      "principal-2",
      "principal-1",
      { ok: false, reason: "unexpected add-on principal: principal-2" },
    ],
  ] as const)("verifies add-on tokens: %s", async (_name, sub, binding, expected) => {
    mockTicket({
      email: "service-123@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
      email_verified: true,
      sub,
    });
    await expect(verifyAppToken(binding)).resolves.toEqual(expected);
  });

  it("fetches Chat certs through the guarded fetch for project-number tokens", async () => {
    expireGoogleChatCertCache();
    mocks.fetchWithSsrFGuard.mockClear();
    const release = guardedResponse(jsonResponse({ "kid-1": "cert-body" }));
    mocks.verifySignedJwtWithCertsAsync.mockReset().mockResolvedValue(undefined);

    await expect(verifyProjectToken()).resolves.toEqual({ ok: true });

    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledWith({
      url: "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com",
      auditContext: "googlechat.auth.certs",
      timeoutMs: 30_000,
    });
    expect(mocks.verifySignedJwtWithCertsAsync).toHaveBeenCalledWith(
      "token",
      { "kid-1": "cert-body" },
      "123456789",
      ["chat@system.gserviceaccount.com"],
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("reports malformed Chat cert JSON with a stable auth error", async () => {
    expireGoogleChatCertCache();
    const release = guardedResponse(
      new Response("{ nope", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(verifyProjectToken()).resolves.toEqual({
      ok: false,
      reason: "Google Chat cert fetch failed: malformed JSON response",
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("caps non-OK sendMessage error bodies before formatting the API error", async () => {
    const chunk = new TextEncoder().encode("x".repeat(1024 * 1024));
    const totalBytes = 32 * chunk.length;
    const streamed = { bytesPulled: 0, canceled: false };
    const release = guardedResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (streamed.bytesPulled >= totalBytes) {
              controller.close();
              return;
            }
            streamed.bytesPulled += chunk.length;
            controller.enqueue(chunk);
          },
          cancel() {
            streamed.canceled = true;
          },
        }),
        { status: 500, statusText: "Internal Server Error" },
      ),
    );

    await expect(send()).rejects.toThrow(/^Google Chat API 500: x+/);

    expect(streamed.canceled).toBe(true);
    expect(streamed.bytesPulled).toBeLessThan(totalBytes);
    expect(release).toHaveBeenCalledOnce();
  });
});
