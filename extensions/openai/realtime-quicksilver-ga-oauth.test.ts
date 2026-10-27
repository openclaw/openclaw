import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createBroker, postOffer, reserveSession } from "./realtime-quicksilver.test-helpers.js";

function makeBroker(fetchImpl: typeof fetch) {
  const harness = createBroker({ fetchImpl });
  onTestFinished(() => harness.realtime.cleanup());
  return harness;
}

const model = "gpt-realtime-2.1";
const defaultAuth = { type: "oauth", token: "oauth-token", accountId: "account-123" } as const;
const accountId = "7a1f92f3-7f0d-4d18-b1a0-8e6bd215c12f";
function reserveOAuth(
  realtime: ReturnType<typeof createBroker>["realtime"],
  auth: { type: "oauth"; token: string; accountId: string } = defaultAuth,
  overrides: { voice?: string; gaSession?: Record<string, unknown> & { model: string } } = {},
) {
  return reserveSession(
    realtime,
    { providerConfig: {}, model, gaSession: { type: "realtime", model }, ...overrides },
    auth,
  );
}

const offer = (realtime: ReturnType<typeof createBroker>["realtime"], token: string) =>
  postOffer(realtime, { token, body: "v=ga-offer\r\n" });

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
    [undefined, "require an initial session policy"],
    [{ type: "realtime", model: "gpt-realtime-2" }, "policy model must match the requested model"],
  ] as const)(
    "rejects GA policy %j before reserving provider state",
    async (gaSession, message) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const { realtime, sockets } = makeBroker(fetchImpl);
      await expect(reserveOAuth(realtime, defaultAuth, { gaSession })).rejects.toThrow(message);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(sockets).toEqual([]);
      expect(realtime.getSessionCounts()).toEqual(emptyCounts);
    },
  );

  it("sends the browser policy as multipart without opening a sideband", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("v=ga-answer\r\n", { status: 201 }),
    );
    const { realtime, sockets } = makeBroker(fetchImpl);
    const gaSession = {
      type: "realtime",
      model: "gpt-realtime-2.1",
      instructions: "Use tools.",
      audio: { output: { voice: "cedar" } },
      tools: [{ type: "function", name: "openclaw_agent_consult", parameters: {} }],
    };
    const reservation = await reserveOAuth(realtime, defaultAuth, { voice: "cedar", gaSession });
    const response = await offer(realtime, reservation.clientSecret);

    expect(response.res.statusCode).toBe(201);
    expect(response.readBody()).toBe("v=ga-answer\r\n");
    expect(sockets).toEqual([]);
    const [url, request] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/realtime/calls");
    expect(request?.method).toBe("POST");
    const headers = new Headers(request?.headers);
    expect(headers.get("Authorization")).toBe("Bearer oauth-token");
    expect(headers.get("chatgpt-account-id")).toBe("account-123");
    expect(headers.get("Content-Type")).toMatch(/^multipart\/form-data; boundary=/);
    expect(headers.has("OpenAI-Alpha")).toBe(false);
    const body = request?.body;
    expect(body).toContain('name="sdp"\r\nContent-Type: application/sdp');
    expect(body).toContain('name="session"\r\nContent-Type: application/json');
    expect(body).toContain(JSON.stringify(gaSession));

    const replay = await offer(realtime, reservation.clientSecret);
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

    const replay = await offer(realtime, reservation.clientSecret);
    expect(replay.res.statusCode).toBe(401);
  });

  it.each([
    ["token", false],
    ["account id", false],
    ["token", true],
    ["account id", true],
  ] as const)("redacts OAuth %s across the cutoff (body cap=%s)", async (kind, bodyCap) => {
    const token = bodyCap
      ? `eyJ${"a".repeat((kind === "token" ? 1_927 : 2_045) - 3)}`
      : "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJib3VuZGFyeSJ9.signature";
    const secret = kind === "token" ? token : accountId;
    const splitAt = Math.floor(secret.length / 2);
    const shrinkablePrefix = token.repeat(8);
    const fillerLength = 16 * 1024 - shrinkablePrefix.length - splitAt;
    const detail = bodyCap
      ? `${shrinkablePrefix}${" ".repeat(fillerLength)}${secret} trailing provider detail`
      : `${"x".repeat(490)}${secret}${"y".repeat(1_000)}`;
    const { response } = await providerFailure(detail, token);

    expect(response.res.statusCode).toBe(502);
    const body = response.readBody();
    if (bodyCap) {
      expect(body).toBe("OpenAI Realtime call creation failed (429)");
    } else {
      expect(body).not.toContain(secret);
      expect(body).not.toContain(secret.slice(0, 12));
      expect(body).toContain("[REDACTED]");
      expect(body.length).toBeLessThan(700);
    }
  });
});
