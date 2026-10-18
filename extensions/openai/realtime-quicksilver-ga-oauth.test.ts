import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENAI_QUICKSILVER_OFFER_PATH } from "./realtime-quicksilver-session.js";
import {
  createBroker,
  createRequest,
  createResponseHarness,
} from "./realtime-quicksilver.test-helpers.js";

const brokers: ReturnType<typeof createBroker>["realtime"][] = [];
function makeBroker(fetchImpl: typeof fetch) {
  const harness = createBroker({ fetchImpl });
  brokers.push(harness.realtime);
  return harness;
}
afterEach(async () => {
  for (const broker of brokers.splice(0)) {
    await broker.cleanup();
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const model = "gpt-realtime-2.1";
const defaultAuth = { type: "oauth", token: "oauth-token", accountId: "account-123" } as const;
const accountId = "7a1f92f3-7f0d-4d18-b1a0-8e6bd215c12f";
async function reserveOAuth(
  realtime: ReturnType<typeof createBroker>["realtime"],
  auth: { type: "oauth"; token: string; accountId: string } = defaultAuth,
  overrides: { voice?: string; gaSession?: Record<string, unknown> & { model: string } } = {},
) {
  const reservation = await realtime.broker.createBrowserSession(
    { providerConfig: {}, model, gaSession: { type: "realtime", model }, ...overrides },
    auth,
  );
  if (reservation.transport !== "webrtc") {
    throw new Error("Expected WebRTC reservation");
  }
  return reservation;
}

async function offer(realtime: ReturnType<typeof createBroker>["realtime"], token: string) {
  const response = createResponseHarness();
  await realtime.handler(createRequest({ token, body: "v=ga-offer\r\n" }), response.res);
  return response;
}

async function providerFailure(detail: string, token: string) {
  const harness = makeBroker(
    vi.fn<typeof fetch>(async () => new Response(detail, { status: 429 })),
  );
  const reservation = await reserveOAuth(harness.realtime, { type: "oauth", token, accountId });
  const response = await offer(harness.realtime, reservation.clientSecret);
  return { ...harness, reservation, response };
}

const emptyCounts = { pending: 0, inFlight: 0, active: 0, reservations: 0 };

describe("GA OAuth offer broker", () => {
  it.each([
    {
      name: "missing",
      gaSession: undefined,
      message: "require an initial session policy",
    },
    {
      name: "mismatched",
      gaSession: { type: "realtime", model: "gpt-realtime-2" },
      message: "policy model must match the requested model",
    },
  ])("rejects a $name GA policy before reserving provider state", async (testCase) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { realtime, sockets } = makeBroker(fetchImpl);
    await expect(
      realtime.broker.createBrowserSession(
        {
          providerConfig: {},
          model: "gpt-realtime-2.1",
          voice: "cedar",
          ...(testCase.gaSession ? { gaSession: testCase.gaSession } : {}),
        },
        defaultAuth,
      ),
    ).rejects.toThrow(testCase.message);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sockets).toEqual([]);
    expect(realtime.getSessionCounts()).toEqual(emptyCounts);
  });

  it("sends the browser policy as multipart without opening a sideband", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("v=ga-answer\r\n", { status: 201 }),
    );
    const { realtime, sockets } = makeBroker(fetchImpl);
    const gaSession = {
      type: "realtime",
      model: "gpt-realtime-2.1",
      instructions: "Use tools.",
      audio: {
        input: { transcription: { model: "gpt-4o-mini-transcribe" } },
        output: { voice: "cedar" },
      },
      tools: [{ type: "function", name: "openclaw_agent_consult", parameters: {} }],
      tool_choice: "auto",
    };
    const reservation = await reserveOAuth(realtime, defaultAuth, { voice: "cedar", gaSession });
    expect(reservation).toMatchObject({
      offerUrl: OPENAI_QUICKSILVER_OFFER_PATH,
      model: "gpt-realtime-2.1",
      voice: "cedar",
    });
    const response = await offer(realtime, reservation.clientSecret);

    expect(response.res.statusCode).toBe(201);
    expect(response.readBody()).toBe("v=ga-answer\r\n");
    expect(sockets).toEqual([]);
    expect(fetchImpl.mock.calls[0]).toEqual([
      "https://api.openai.com/v1/realtime/calls",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer oauth-token",
          "chatgpt-account-id": "account-123",
          "Content-Type": expect.stringMatching(/^multipart\/form-data; boundary=/),
        }),
      }),
    ]);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).not.toHaveProperty("OpenAI-Alpha");
    const body = fetchImpl.mock.calls[0]?.[1]?.body;
    expect(body).toBeTypeOf("string");
    expect(body).toContain('name="sdp"\r\nContent-Type: application/sdp');
    expect(body).toContain('name="session"\r\nContent-Type: application/json');
    expect(body).toContain(JSON.stringify(gaSession));

    const replay = createResponseHarness();
    await realtime.handler(createRequest({ token: reservation.clientSecret }), replay.res);
    expect(replay.res.statusCode).toBe(401);
  });

  it("redacts OAuth identity from a bounded browser-visible provider failure", async () => {
    const token = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0In0.signature";
    const detail = `safe diagnostic token=${token} account=${accountId} ${"x".repeat(1_000)}`;
    const { realtime, sockets, reservation, response } = await providerFailure(detail, token);

    expect(response.res.statusCode).toBe(502);
    expect(response.readBody()).toContain("safe diagnostic");
    expect(response.readBody()).not.toContain(token);
    expect(response.readBody()).not.toContain(accountId);
    expect(response.readBody().length).toBeLessThan(700);
    expect(sockets).toEqual([]);
    expect(realtime.getSessionCounts()).toEqual(emptyCounts);

    const replay = createResponseHarness();
    await realtime.handler(createRequest({ token: reservation.clientSecret }), replay.res);
    expect(replay.res.statusCode).toBe(401);
  });

  it.each(["token", "account id"])(
    "redacts an OAuth %s that straddles the detail cutoff",
    async (kind) => {
      const token = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJib3VuZGFyeSJ9.signature";
      const secret = kind === "token" ? token : accountId;
      const secretPrefix = secret.slice(0, 12);
      const detail = `${"x".repeat(490)}${secret}${"y".repeat(1_000)}`;
      const { response } = await providerFailure(detail, token);

      expect(response.res.statusCode).toBe(502);
      expect(response.readBody()).not.toContain(secret);
      expect(response.readBody()).not.toContain(secretPrefix);
      expect(response.readBody()).toContain("[REDACTED]");
      expect(response.readBody().length).toBeLessThan(700);
    },
  );

  it.each(["token", "account id"])(
    "drops a provider error when an OAuth %s straddles the body cap",
    async (kind) => {
      const token = `eyJ${"a".repeat((kind === "token" ? 1_927 : 2_045) - 3)}`;
      const secret = kind === "token" ? token : accountId;
      const splitAt = Math.floor(secret.length / 2);
      const shrinkablePrefix = token.repeat(8);
      const fillerLength = 16 * 1024 - shrinkablePrefix.length - splitAt;
      expect(fillerLength).toBeGreaterThanOrEqual(0);
      const detail = `${shrinkablePrefix}${" ".repeat(fillerLength)}${secret} trailing provider detail`;
      const { response } = await providerFailure(detail, token);

      expect(response.res.statusCode).toBe(502);
      expect(response.readBody()).not.toContain(secret.slice(0, splitAt));
      expect(response.readBody()).not.toContain(secret.slice(splitAt));
      expect(response.readBody()).not.toContain("trailing provider detail");
      expect(response.readBody()).toBe("OpenAI Realtime call creation failed (429)");
    },
  );
});
