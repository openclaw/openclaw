import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveUploadSiteId } from "./graph-upload.js";
import { MSTEAMS_REQUEST_TIMEOUT_MS } from "./request-timeout.js";

const tokenProvider = { getAccessToken: vi.fn(async () => "graph-token") };

type FetchCall = [string, { method?: string; headers?: Record<string, string> } | undefined];

function requireFetchCall(fetchFn: ReturnType<typeof vi.fn>, index = 0): FetchCall {
  const call = fetchFn.mock.calls[index] as unknown as FetchCall | undefined;
  if (!call) {
    throw new Error(`fetch call ${index} missing`);
  }
  return call;
}

type GraphRoute = {
  includes: string;
  respond: (init?: RequestInit) => Response | Promise<Response>;
};

function stubGraphFetch(fetchFn: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", withFetchPreconnect(fetchFn));
}

function createGraphFetch(...routes: GraphRoute[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const route = routes.find((candidate) => url.includes(candidate.includes));
    if (!route) {
      throw new Error(`Unexpected SharePoint request: ${url}`);
    }
    return await route.respond(init);
  });
}

function fixedGraphRoute(includes: string, value: unknown, status = 200): GraphRoute {
  return {
    includes,
    respond: () =>
      typeof value === "string"
        ? new Response(value, { status })
        : Response.json(value, { status }),
  };
}

function createGraphSendAuthority() {
  let current = true;
  const error = new Error("Teams send authority closed");
  return {
    error,
    revoke: () => {
      current = false;
    },
    handoff: {
      assertDirectAdapterHandoff: () => {
        if (!current) {
          throw error;
        }
      },
      onPlatformSendDispatch: vi.fn(async () => {}),
    },
  };
}

function abortReasonError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("fetch request aborted");
}

function hangingGraphRoute(includes: string): GraphRoute {
  return {
    includes,
    respond: async (init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("Expected fetch AbortSignal"));
          return;
        }
        signal.addEventListener("abort", () => reject(abortReasonError(signal)), { once: true });
      }),
  };
}

async function waitForFetchCall(fetchFn: ReturnType<typeof vi.fn>, index = 0): Promise<void> {
  await vi.waitFor(() => requireFetchCall(fetchFn, index));
}

function fetchSignal(fetchFn: ReturnType<typeof vi.fn>, index = 0): AbortSignal {
  const [, init] = requireFetchCall(fetchFn, index);
  const signal = (init as RequestInit | undefined)?.signal;
  if (!(signal instanceof AbortSignal)) {
    throw new Error("Expected fetch AbortSignal");
  }
  return signal;
}

function expectMSTeamsTimeout(promise: Promise<unknown>, label: string, timeoutMs: number) {
  return expect(promise).rejects.toMatchObject({
    name: "TimeoutError",
    message: `${label} timed out after ${timeoutMs}ms`,
  });
}

describe("resolveUploadSiteId dynamic resolution", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    tokenProvider.getAccessToken.mockClear();
  });

  it("throws when no team context and no configured site", async () => {
    await expect(resolveUploadSiteId({ tokenProvider })).rejects.toThrow(
      "No SharePoint site ID available",
    );
  });

  it("throws when team ID is present but group ID cannot be resolved", async () => {
    await expect(resolveUploadSiteId({ teamId: "unknown-team", tokenProvider })).rejects.toThrow(
      "Could not resolve AAD group ID",
    );
  });

  it("uses getTeamDetails to resolve a cold-start group ID then discovers the site", async () => {
    const getTeamDetails = vi.fn(async () => ({ aadGroupId: "group-cold" }));
    const fetchFn = createGraphFetch(
      fixedGraphRoute("membershipType", { membershipType: "standard" }),
      fixedGraphRoute("/sites/root", { id: "site-discovered" }),
    );

    stubGraphFetch(fetchFn);
    const result = await resolveUploadSiteId({
      teamId: "19:team-cold@thread.skype",
      channelId: "19:channel-cold@thread.tacv2",
      tokenProvider,
      getTeamDetails,
    });

    expect(result).toBe("site-discovered");
    expect(getTeamDetails).toHaveBeenCalledWith("19:team-cold@thread.skype");
  });

  it("rejects private channels before discovering the parent team site", async () => {
    const fetchFn = createGraphFetch(
      fixedGraphRoute("membershipType", { membershipType: "private" }),
    );

    stubGraphFetch(fetchFn);
    await expect(
      resolveUploadSiteId({
        teamId: "19:team-private@thread.skype",
        channelId: "19:private@thread.tacv2",
        tokenProvider,
        getTeamDetails: async () => ({ aadGroupId: "group-private" }),
      }),
    ).rejects.toThrow("standard channels only");
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes("/sites/root"))).toBe(false);
  });

  it("stops team lookup when delivery authority is already closed", async () => {
    const authority = createGraphSendAuthority();
    authority.revoke();
    const getTeamDetails = vi.fn(async () => ({ aadGroupId: "group-revoked" }));
    const fetchFn = createGraphFetch(
      fixedGraphRoute("membershipType", { membershipType: "standard" }),
      fixedGraphRoute("/sites/root", { id: "site-should-not-load" }),
    );

    stubGraphFetch(fetchFn);
    await expect(
      resolveUploadSiteId({
        teamId: "19:team-revoked@thread.skype",
        channelId: "19:channel-revoked@thread.tacv2",
        tokenProvider,
        getTeamDetails,
        ...authority.handoff,
      }),
    ).rejects.toMatchObject({ cause: authority.error });
    expect(getTeamDetails).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(tokenProvider.getAccessToken).not.toHaveBeenCalled();
  });

  it("stops Graph discovery when delivery authority closes after team lookup", async () => {
    const authority = createGraphSendAuthority();
    const getTeamDetails = vi.fn(async () => {
      authority.revoke();
      return { aadGroupId: "group-revoked" };
    });
    const fetchFn = createGraphFetch(
      fixedGraphRoute("membershipType", { membershipType: "standard" }),
      fixedGraphRoute("/sites/root", { id: "site-should-not-load" }),
    );

    stubGraphFetch(fetchFn);
    await expect(
      resolveUploadSiteId({
        teamId: "19:team-after-lookup@thread.skype",
        channelId: "19:channel-after-lookup@thread.tacv2",
        tokenProvider,
        getTeamDetails,
        ...authority.handoff,
      }),
    ).rejects.toMatchObject({ cause: authority.error });
    expect(getTeamDetails).toHaveBeenCalledOnce();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(tokenProvider.getAccessToken).not.toHaveBeenCalled();
  });

  it("stops the site request when delivery authority closes after the membership check", async () => {
    const authority = createGraphSendAuthority();
    const membership = fixedGraphRoute("membershipType", { membershipType: "standard" });
    const fetchFn = createGraphFetch(
      {
        includes: membership.includes,
        respond: async (init) => {
          const response = await membership.respond(init);
          authority.revoke();
          return response;
        },
      },
      fixedGraphRoute("/sites/root", { id: "site-should-not-load" }),
    );

    stubGraphFetch(fetchFn);
    await expect(
      resolveUploadSiteId({
        teamId: "19:team-after-membership@thread.skype",
        channelId: "19:channel-after-membership@thread.tacv2",
        tokenProvider,
        getTeamDetails: async () => ({ aadGroupId: "group-standard" }),
        ...authority.handoff,
      }),
    ).rejects.toMatchObject({ cause: authority.error });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes("/sites/root"))).toBe(false);
  });

  it("skips membership lookup when an explicit site is configured", async () => {
    const fetchFn = createGraphFetch();
    const getTeamDetails = vi.fn(async () => ({ aadGroupId: "unused" }));

    stubGraphFetch(fetchFn);
    const result = await resolveUploadSiteId({
      configuredSiteId: "explicit-site",
      teamId: "19:team@thread.skype",
      channelId: "19:private@thread.tacv2",
      tokenProvider,
      getTeamDetails,
    });

    expect(result).toBe("explicit-site");
    expect(getTeamDetails).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("aborts a stalled site-discovery fetch when the request deadline expires", async () => {
    vi.useFakeTimers();
    const fetchFn = createGraphFetch(
      fixedGraphRoute("membershipType", { membershipType: "standard" }),
      hangingGraphRoute("/sites/root"),
    );
    stubGraphFetch(fetchFn);
    const discovery = resolveUploadSiteId({
      teamId: "19:team-hang@thread.skype",
      channelId: "19:channel-hang@thread.tacv2",
      tokenProvider,
      getTeamDetails: async () => ({ aadGroupId: "group-hang" }),
    });

    await vi.advanceTimersByTimeAsync(0);
    await waitForFetchCall(fetchFn, 1);
    const signal = fetchSignal(fetchFn, 1);
    const assertion = expectMSTeamsTimeout(
      discovery,
      "MS Teams SharePoint request",
      MSTEAMS_REQUEST_TIMEOUT_MS,
    );

    await vi.advanceTimersByTimeAsync(MSTEAMS_REQUEST_TIMEOUT_MS);

    await assertion;
    expect(signal.aborted).toBe(true);
  });
});
