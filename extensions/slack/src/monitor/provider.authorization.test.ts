import { describe, expect, it, vi } from "vitest";
import { createSlackBoltApp, resolveSlackBoltInterop } from "./provider-support.js";

async function createFixture(authResponses = [{ ok: true, user_id: "UBOT", bot_id: "BBOT" }]) {
  const bolt = await import("@slack/bolt");
  const requests: { method: string; authorization: string | null }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const method = new URL(input instanceof Request ? input.url : input).pathname
      .split("/")
      .at(-1)!;
    requests.push({ method, authorization: new Headers(init?.headers).get("authorization") });
    return Response.json(
      method === "auth.test"
        ? (authResponses.shift() ?? { ok: true, user_id: "UBOT", bot_id: "BBOT" })
        : { ok: true },
    );
  });
  const fixture = createSlackBoltApp({
    interop: resolveSlackBoltInterop({ defaultImport: bolt.default, namespaceImport: bolt }),
    slackMode: "relay",
    token: "xoxb-synthetic-test",
    slackWebhookPath: "/slack/events",
    clientOptions: { fetch },
  });
  const delivered: { botUserId?: string; isEnterpriseInstall?: boolean }[] = [];
  const errors: Error[] = [];
  fixture.app.error(async (error) => {
    errors.push(error);
  });
  fixture.app.event("message", async ({ context }) => {
    delivered.push({
      botUserId: context.botUserId,
      isEnterpriseInstall: context.isEnterpriseInstall,
    });
  });
  const receive = (isEnterpriseInstall = false) =>
    fixture.app.processEvent({
      body: {
        type: "event_callback",
        team_id: "TTEST",
        enterprise_id: "ETEST",
        authorizations: [{ is_enterprise_install: isEnterpriseInstall }],
        event: { type: "message", user: "UOTHER", channel: "CTEST", text: "hello", ts: "1.1" },
      },
      ack: async () => {},
    });
  return { ...fixture, requests, delivered, errors, receive };
}

describe("Slack event authorization", () => {
  it("shares successful authorization across concurrent and subsequent events", async () => {
    const fixture = await createFixture();
    expect(fixture.requests).toEqual([]);
    await Promise.all(Array.from({ length: 10 }, () => fixture.receive()));
    for (let i = 0; i < 10; i++) {
      await fixture.receive(true);
    }
    expect(fixture.errors).toEqual([]);
    expect(fixture.delivered).toEqual([
      ...Array.from({ length: 10 }, () => ({ botUserId: "UBOT", isEnterpriseInstall: false })),
      ...Array.from({ length: 10 }, () => ({ botUserId: "UBOT", isEnterpriseInstall: true })),
    ]);
    expect(fixture.requests.filter(({ method }) => method === "auth.test")).toHaveLength(1);
    await fixture.app.client.apiCall("api.test");
    expect(fixture.requests.at(-1)).toEqual({
      method: "api.test",
      authorization: "Bearer xoxb-synthetic-test",
    });
  });

  it("retries failed authorization instead of caching the rejection", async () => {
    const fixture = await createFixture([{ ok: false, user_id: "", bot_id: "" }]);
    await fixture.receive();
    expect(fixture.errors).toHaveLength(1);
    expect(fixture.delivered).toEqual([]);
    await fixture.receive();
    await fixture.receive();
    expect(fixture.delivered).toHaveLength(2);
    expect(fixture.requests.filter(({ method }) => method === "auth.test")).toHaveLength(2);
  });

  it("reuses startup identity, refreshes recovery, and isolates account instances", async () => {
    const fixture = await createFixture();
    await fixture.readAuthIdentity();
    await fixture.receive();
    expect(fixture.requests).toHaveLength(1);
    await fixture.readAuthIdentity(true);
    await fixture.receive();
    expect(fixture.requests).toHaveLength(2);
    const other = await createFixture();
    await other.receive();
    expect(other.requests).toHaveLength(1);
    expect(other.delivered).toHaveLength(1);
    expect(fixture.delivered).toHaveLength(2);
  });
});
