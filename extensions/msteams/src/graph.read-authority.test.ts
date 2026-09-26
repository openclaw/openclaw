import { createServer, type Server, type ServerResponse } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  origin: "",
  prepareSdk: vi.fn<() => Promise<void>>(),
  acquireToken: vi.fn<(scope: string) => Promise<string>>(),
  acquireDelegatedToken: vi.fn<() => Promise<string | undefined>>(),
  authority: undefined as (() => void) | undefined,
  beforeLookup: undefined as (() => void | Promise<void>) | undefined,
  afterRead: undefined as (() => void) | undefined,
  releases: 0,
}));

vi.mock("openclaw/plugin-sdk/fetch-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/fetch-runtime")>()),
  captureChannelReadAuthority: () => transport.authority,
}));

vi.mock("./sdk.js", () => ({
  async loadMSTeamsSdkWithAuth() {
    await transport.prepareSdk();
    return { app: {} };
  },
  createMSTeamsTokenProvider() {
    return { getAccessToken: transport.acquireToken };
  },
}));

vi.mock("./token.js", async (original) => ({
  ...(await original<typeof import("./token.js")>()),
  resolveDelegatedAccessToken: transport.acquireDelegatedToken,
}));

vi.mock("../runtime-api.js", async (original) => {
  const actual = await original<typeof import("../runtime-api.js")>();
  return {
    ...actual,
    async fetchWithSsrFGuard(params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) {
      const url = new URL(params.url);
      // Keep the actual guard, pinned transport and body cleanup; only route Graph to the fixture.
      const guarded = await actual.fetchWithSsrFGuard({
        ...params,
        url: `${transport.origin}${url.pathname}${url.search}`,
        policy: { allowPrivateNetwork: true },
        lookupFn: async () => {
          await transport.beforeLookup?.();
          return [{ address: "127.0.0.1", family: 4 }];
        },
      });
      return {
        ...guarded,
        release: async () => {
          transport.releases++;
          await guarded.release();
        },
      };
    },
  };
});

vi.mock("openclaw/plugin-sdk/provider-http", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/provider-http")>();
  return {
    ...actual,
    async readProviderJsonResponse(...args: Parameters<typeof actual.readProviderJsonResponse>) {
      const result = await actual.readProviderJsonResponse(...args);
      transport.afterRead?.();
      return result;
    },
  };
});

import { msteamsPlugin } from "./channel.js";
import { getMemberInfoMSTeams } from "./graph-members.js";
import { getMessageMSTeams, listPinsMSTeams } from "./graph-messages.js";
import { listChannelsMSTeams } from "./graph-teams.js";
import { fetchGraphAbsoluteUrl, fetchGraphJson } from "./graph.js";

const cfg = {
  channels: {
    msteams: {
      authType: "secret" as const,
      appId: "11111111-1111-1111-1111-111111111111",
      appPassword: "synthetic-app-password",
      tenantId: "22222222-2222-2222-2222-222222222222",
    },
  },
};
const graphToken = "synthetic-graph-token";
const chatId = "19:allowed@thread.v2";
const teamId = "33333333-3333-3333-3333-333333333333";
const channelId = "19:allowed@thread.tacv2";
const message = { id: "message-1", body: { content: "Permitted context" } };

function createReader() {
  let active = true;
  return {
    assert: () => {
      if (!active) {
        throw new Error("Teams read authority revoked");
      }
    },
    revoke: () => {
      active = false;
      transport.authority = undefined;
    },
  };
}

let server: Server;
let requests: string[];
let requestAuthorizations: Array<string | undefined>;
let respond: (url: string, response: ServerResponse) => void;

beforeEach(async () => {
  transport.prepareSdk.mockReset().mockResolvedValue(undefined);
  transport.acquireToken.mockReset().mockResolvedValue(graphToken);
  transport.acquireDelegatedToken.mockReset().mockResolvedValue(undefined);
  transport.authority = undefined;
  transport.beforeLookup = undefined;
  transport.afterRead = undefined;
  transport.releases = 0;
  requests = [];
  requestAuthorizations = [];
  respond = (_url, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(message));
  };
  server = createServer((request, response) => {
    const url = request.url ?? "/";
    requests.push(`${request.method} ${url}`);
    requestAuthorizations.push(request.headers.authorization);
    request.resume();
    respond(url, response);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a loopback server port");
  }
  transport.origin = `http://msteams-proof.invalid:${address.port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("Teams Graph read authority", () => {
  it.each([
    ["sdk", false],
    ["sdk", true],
    ["token", false],
    ["token", true],
  ] as const)(
    "holds %s preparation without reviving a revoked read (revoked=%s)",
    async (stage, revoked) => {
      const reader = createReader();
      transport.authority = reader.assert;
      const started = createDeferred<void>();
      const finish = createDeferred<void>();
      const hold = async () => {
        started.resolve();
        await finish.promise;
      };
      if (stage === "sdk") {
        transport.prepareSdk.mockImplementation(hold);
      } else {
        transport.acquireToken.mockImplementation(async () => {
          await hold();
          return graphToken;
        });
      }
      const result = getMessageMSTeams({ cfg, to: chatId, messageId: message.id });
      const expected = revoked
        ? expect(result).rejects.toThrow("Teams read authority revoked")
        : expect(result).resolves.toMatchObject({ id: message.id, text: message.body.content });
      await started.promise;
      if (revoked) {
        reader.revoke();
      }
      finish.resolve();
      await expected;
      expect(requests).toHaveLength(revoked ? 0 : 1);
      expect(transport.acquireToken).toHaveBeenCalledTimes(stage === "sdk" && revoked ? 0 : 1);
    },
  );

  const fetches = {
    relative: () => fetchGraphJson({ token: graphToken, path: "/groups" }),
    absolute: () =>
      fetchGraphAbsoluteUrl({ token: graphToken, url: "https://graph.microsoft.com/v1.0/groups" }),
  };

  it.each(["relative", "absolute"] as const)(
    "checks %s requests after DNS preparation",
    async (kind) => {
      const reader = createReader();
      transport.authority = reader.assert;
      transport.beforeLookup = reader.revoke;
      await expect(fetches[kind]()).rejects.toThrow("Teams read authority revoked");
      expect(requests).toEqual([]);
    },
  );

  it("checks redirect attempts before issuing the next request", async () => {
    const reader = createReader();
    transport.authority = reader.assert;
    respond = (url, response) => {
      if (url === "/v1.0/groups") {
        reader.revoke();
        response.writeHead(302, { location: "/v1.0/redirected" });
        response.end();
      } else {
        response.end(JSON.stringify({ value: [] }));
      }
    };
    await expect(fetches.relative()).rejects.toThrow("Teams read authority revoked");
    expect(requests).toEqual(["GET /v1.0/groups"]);
  });

  it.each(["relative", "absolute"] as const)(
    "withholds a %s result revoked during body consumption and releases it",
    async (kind) => {
      const reader = createReader();
      transport.authority = reader.assert;
      const results: unknown[] = [];
      transport.afterRead = reader.revoke;
      const read = async () => {
        const result = await fetches[kind]();
        results.push(result);
      };
      await expect(read()).rejects.toThrow("Teams read authority revoked");
      expect(results).toEqual([]);
      expect(requests).toHaveLength(1);
      expect(transport.releases).toBe(1);
    },
  );

  it.each(["pins", "channels", "members"] as const)(
    "stops the next %s lookup after revocation",
    async (kind) => {
      const reader = createReader();
      transport.authority = reader.assert;
      respond = (url, response) => {
        reader.revoke();
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            kind === "members"
              ? url.includes("membershipType")
                ? { membershipType: "standard" }
                : { value: [] }
              : {
                  value: [],
                  ...(!url.includes("second")
                    ? { "@odata.nextLink": "https://graph.microsoft.com/v1.0/second" }
                    : {}),
                },
          ),
        );
      };
      const read = async () => {
        if (kind === "pins") {
          return listPinsMSTeams({ cfg, to: chatId });
        }
        if (kind === "channels") {
          return listChannelsMSTeams({ cfg, teamId });
        }
        return getMemberInfoMSTeams({
          cfg,
          to: `${teamId}/${channelId}`,
          userId: "44444444-4444-4444-4444-444444444444",
        });
      };
      await expect(read()).rejects.toThrow("Teams read authority revoked");
      expect(requests).toHaveLength(1);
      expect(transport.releases).toBe(1);
    },
  );
});

describe("Teams Graph mutation currentness", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const)(
    "rechecks a delegated token wait before success or fallback (fallback=%s, revoked=%s)",
    async (fallback, revoked) => {
      const caller = new AbortController();
      const started = createDeferred<void>();
      const finish = createDeferred<void>();
      const delegatedToken = "synthetic-delegated-graph-token";
      transport.acquireDelegatedToken.mockImplementationOnce(async () => {
        started.resolve();
        await finish.promise;
        return fallback ? undefined : delegatedToken;
      });
      const result = msteamsPlugin.actions!.handleAction!({
        channel: "msteams",
        action: "react",
        cfg: {
          channels: {
            msteams: { ...cfg.channels.msteams, delegatedAuth: { enabled: true } },
          },
        },
        accountId: "default",
        requesterAccountId: "default",
        params: { target: chatId, messageId: message.id, emoji: "like" },
        toolContext: {
          currentChannelProvider: "msteams",
          currentChannelId: chatId,
          currentChatType: "direct",
        },
        assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
      });
      const expected = revoked
        ? expect(result).rejects.toThrow("Teams mutation caller revoked")
        : expect(result).resolves.toMatchObject({
            details: { ok: true, channel: "msteams", action: "react", reactionType: "like" },
          });
      await started.promise;
      if (revoked) {
        caller.abort(new Error("Teams mutation caller revoked"));
      }
      finish.resolve();
      await expected;
      expect(requests).toEqual(
        revoked
          ? []
          : [`POST /beta/chats/${encodeURIComponent(chatId)}/messages/${message.id}/setReaction`],
      );
      expect(requestAuthorizations).toEqual(
        revoked ? [] : [`Bearer ${fallback ? graphToken : delegatedToken}`],
      );
      expect(transport.acquireDelegatedToken).toHaveBeenCalledOnce();
      expect(transport.prepareSdk).toHaveBeenCalledTimes(fallback && !revoked ? 1 : 0);
      expect(transport.acquireToken).toHaveBeenCalledTimes(fallback && !revoked ? 1 : 0);
    },
  );
});
