import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { resolveGoogleChatAccount } from "./accounts.js";
import { startGoogleChatSpaceCache } from "./space-cache.js";
import {
  resolveGoogleChatOutboundSessionRoute,
  resolveGoogleChatOutboundSpace,
} from "./targets.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(
    async (params: { url: string; init?: RequestInit; timeoutMs?: number }) => ({
      response: await fetch(params.url, params.init),
      release: async () => {},
    }),
  ),
  getGoogleChatAccessToken: vi.fn().mockResolvedValue("token"),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

vi.mock("./auth.js", () => ({
  getGoogleChatAccessToken: mocks.getGoogleChatAccessToken,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.doUnmock("./auth.js");
  vi.resetModules();
});

describe("outbound session routing", () => {
  it("retains delivery's direct-message lookup metadata for later route classification", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ name: "spaces/DM-AAA", spaceType: "DIRECT_MESSAGE" }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const space = await resolveGoogleChatOutboundSpace({
      account: resolveGoogleChatAccount({ cfg: {} }),
      target: "users/alice",
    });

    const route = await resolveGoogleChatOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: space,
    });

    expect(route).toMatchObject({
      peer: { kind: "direct", id: "spaces/DM-AAA" },
      chatType: "direct",
      from: "googlechat:spaces/DM-AAA",
      to: "spaces/DM-AAA",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://chat.googleapis.com/v1/spaces:findDirectMessage?name=users%2Falice",
      {
        method: "GET",
        headers: {
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        },
      },
    );
  });

  it("isolates classification by account, credentials, and monitor lifecycle", async () => {
    let requestCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      const spaceType = ++requestCount === 1 ? "DIRECT_MESSAGE" : "SPACE";
      return new Response(JSON.stringify({ name: "spaces/SHARED", spaceType }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const cfg = {
      channels: {
        googlechat: {
          accounts: {
            first: {
              serviceAccount: { client_email: "first@example.test", private_key: "first-key" },
            },
            second: {
              serviceAccount: { client_email: "second@example.test", private_key: "second-key" },
            },
          },
        },
      },
    };
    const destination = { cfg, agentId: "main", target: "spaces/SHARED" };
    expect(
      await resolveGoogleChatOutboundSessionRoute({ ...destination, accountId: "first" }),
    ).toMatchObject({ chatType: "direct" });
    expect(
      await resolveGoogleChatOutboundSessionRoute({ ...destination, accountId: "second" }),
    ).toMatchObject({ chatType: "group" });
    cfg.channels.googlechat.accounts.first.serviceAccount.private_key = "rotated-key";
    expect(
      await resolveGoogleChatOutboundSessionRoute({ ...destination, accountId: "first" }),
    ).toMatchObject({ chatType: "group" });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const stop = startGoogleChatSpaceCache(resolveGoogleChatAccount({ cfg, accountId: "first" }));
    try {
      await resolveGoogleChatOutboundSessionRoute({ ...destination, accountId: "first" });
      await resolveGoogleChatOutboundSessionRoute({ ...destination, accountId: "first" });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      stop();
    }
  });
});
