// Matrix tests cover session route plugin behavior.
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, describe, expect, it } from "vitest";
import { resolveMatrixOutboundSessionRoute } from "./session-route.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync(sessionRoot);
    cleanup();
  });
});
const sessionRoot = tempDirs.make("matrix-session-route-");
const currentDmSessionKey = "agent:main:matrix:channel:!dm:example.org";
type MatrixChannelConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["matrix"]>;

const perRoomDmMatrixConfig = { dm: { sessionScope: "per-room" } } satisfies MatrixChannelConfig;

const defaultAccountPerRoomDmMatrixConfig = {
  defaultAccount: "ops",
  accounts: {
    ops: perRoomDmMatrixConfig,
  },
} satisfies MatrixChannelConfig;

async function createTempStore(entries: Record<string, SessionEntry>): Promise<string> {
  const tempDir = tempDirs.make("case-", sessionRoot);
  const storePath = path.join(tempDir, "sessions.json");
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await upsertSessionEntry({ sessionKey, storePath, entry });
  }
  return storePath;
}

async function createMatrixRouteConfig(
  entries: Record<string, SessionEntry>,
  matrix: MatrixChannelConfig = perRoomDmMatrixConfig,
): Promise<OpenClawConfig> {
  return {
    session: { store: await createTempStore(entries) },
    channels: { matrix },
  } satisfies OpenClawConfig;
}

function createStoredDirectDmSession(
  params: {
    from?: string;
    to?: string;
    accountId?: string | null;
    nativeChannelId?: string;
    nativeDirectUserId?: string;
  } = {},
): SessionEntry {
  const accountId = params.accountId === null ? undefined : (params.accountId ?? "ops");
  const to = params.to ?? "room:!dm:example.org";
  const accountMetadata = accountId ? { accountId } : {};
  const nativeMetadata = {
    ...(params.nativeChannelId ? { nativeChannelId: params.nativeChannelId } : {}),
    ...(params.nativeDirectUserId ? { nativeDirectUserId: params.nativeDirectUserId } : {}),
  };
  return {
    sessionId: "sess-1",
    updatedAt: Date.now(),
    chatType: "direct",
    delivery: normalizeSessionDeliveryState({
      origin: {
        chatType: "direct",
        from: params.from ?? "matrix:@alice:example.org",
        to,
        ...nativeMetadata,
        ...accountMetadata,
      },
      context: { channel: "matrix", to, ...accountMetadata },
    }),
  };
}

function createStoredChannelSession(): SessionEntry {
  return {
    sessionId: "sess-1",
    updatedAt: Date.now(),
    chatType: "channel",
    delivery: normalizeSessionDeliveryState({
      origin: {
        chatType: "channel",
        from: "matrix:channel:!ops:example.org",
        to: "room:!ops:example.org",
        nativeChannelId: "!ops:example.org",
        nativeDirectUserId: "@alice:example.org",
        accountId: "ops",
      },
      context: {
        channel: "matrix",
        to: "room:!ops:example.org",
        accountId: "ops",
      },
    }),
  };
}

function resolveUserRoute(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  target?: string;
  currentSessionKey?: string;
}) {
  const target = params.target ?? "@alice:example.org";
  return resolveMatrixOutboundSessionRoute({
    cfg: params.cfg,
    agentId: "main",
    ...(params.accountId ? { accountId: params.accountId } : {}),
    currentSessionKey: params.currentSessionKey ?? currentDmSessionKey,
    target,
    resolvedTarget: { to: target, kind: "user", source: "normalized" },
  });
}

async function resolveUserRouteForCurrentSession(params: {
  storedSession: SessionEntry;
  accountId?: string;
  target?: string;
  matrix?: MatrixChannelConfig;
}) {
  return resolveUserRoute({
    cfg: await createMatrixRouteConfig(
      {
        [currentDmSessionKey]: params.storedSession,
      },
      params.matrix ?? perRoomDmMatrixConfig,
    ),
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(params.target ? { target: params.target } : {}),
  });
}

function expectCurrentDmRoomRoute(
  route: Awaited<ReturnType<typeof resolveMatrixOutboundSessionRoute>>,
) {
  expect(expectRoute(route)).toMatchObject({
    sessionKey: currentDmSessionKey,
    baseSessionKey: currentDmSessionKey,
    peer: { kind: "channel", id: "!dm:example.org" },
    chatType: "direct",
    from: "matrix:@alice:example.org",
    to: "room:!dm:example.org",
    recipientSessionExact: true,
  });
}

function expectFallbackUserRoute(
  route: Awaited<ReturnType<typeof resolveMatrixOutboundSessionRoute>>,
  params?: {
    userId?: string;
  },
) {
  const userId = params?.userId ?? "@alice:example.org";
  expect(expectRoute(route)).toMatchObject({
    sessionKey: "agent:main:main",
    baseSessionKey: "agent:main:main",
    peer: { kind: "direct", id: userId },
    chatType: "direct",
    from: `matrix:${userId}`,
    to: `room:${userId}`,
    recipientSessionExact: false,
  });
}

function expectRoute(route: Awaited<ReturnType<typeof resolveMatrixOutboundSessionRoute>>) {
  if (!route) {
    throw new Error("Expected Matrix route");
  }
  return route;
}

describe("resolveMatrixOutboundSessionRoute", () => {
  const driftedSession = () =>
    createStoredDirectDmSession({
      from: "matrix:@bob:example.org",
      to: "room:@bob:example.org",
      nativeChannelId: "!dm:example.org",
      nativeDirectUserId: "@alice:example.org",
    });
  it("falls back to user-scoped routing when the current session belongs to another Matrix account", async () => {
    const route = await resolveUserRouteForCurrentSession({
      storedSession: createStoredDirectDmSession(),
      accountId: "support",
    });

    expectFallbackUserRoute(route);
  });

  it("reuses the canonical DM room after user-target outbound metadata overwrites latest to fields", async () => {
    const route = await resolveUserRouteForCurrentSession({
      storedSession: driftedSession(),
      accountId: "ops",
    });

    expectCurrentDmRoomRoute(route);
  });

  it("does not reuse the canonical DM room for a different Matrix user after latest metadata drift", async () => {
    const route = await resolveUserRouteForCurrentSession({
      storedSession: driftedSession(),
      accountId: "ops",
      target: "@bob:example.org",
    });

    expectFallbackUserRoute(route, { userId: "@bob:example.org" });
  });

  it("does not reuse a room after the session metadata was overwritten by a non-DM Matrix send", async () => {
    const route = await resolveUserRouteForCurrentSession({
      storedSession: createStoredChannelSession(),
      accountId: "ops",
    });

    expectFallbackUserRoute(route);
  });

  it("reuses the current DM room when stored account metadata is missing", async () => {
    const route = await resolveUserRouteForCurrentSession({
      storedSession: createStoredDirectDmSession({ accountId: null }),
      matrix: defaultAccountPerRoomDmMatrixConfig,
    });

    expectCurrentDmRoomRoute(route);
  });

  it("uses the Matrix thread root when replying to a child event", async () => {
    const threadId = "$ThreadRoot:Example.Org";
    const route = expectRoute(
      await resolveMatrixOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        target: "room:!ops:example.org",
        threadId,
        replyToId: "$ReplyChild:Example.Org",
      }),
    );

    expect(route.threadId).toBe(threadId);
    expect(route.sessionKey).toBe(`agent:main:matrix:channel:!ops:example.org:thread:${threadId}`);
  });

  it("claims a room version 12 room id (no :server suffix) as canonical when DMs are room-scoped", async () => {
    // Room version 12 (MSC4291) dropped the trailing ":server" from room IDs.
    const route = await resolveMatrixOutboundSessionRoute({
      cfg: { channels: { matrix: perRoomDmMatrixConfig } },
      agentId: "main",
      target: "room:!UIZ0YzC99dC1AyEM6mGl0_XNP8u8xeCCt_Zk8Uhkp70",
    });

    expect(route?.recipientSessionExact).toBe(true);
  });

  it("resolves per-room DM metadata from the base key when currentSessionKey has a thread suffix", async () => {
    const threadedRoute = await resolveUserRoute({
      cfg: await createMatrixRouteConfig({
        [currentDmSessionKey]: createStoredDirectDmSession(),
      }),
      accountId: "ops",
      currentSessionKey: `${currentDmSessionKey}:thread:$DmRoot:Example.Org`,
    });

    const dmThreadRoute = expectRoute(threadedRoute);
    expect(dmThreadRoute.sessionKey).toBe(`${currentDmSessionKey}:thread:$DmRoot:Example.Org`);
    expect(dmThreadRoute.baseSessionKey).toBe(currentDmSessionKey);
    expect(dmThreadRoute.to).toBe("room:!dm:example.org");
    expect(dmThreadRoute.threadId).toBe("$DmRoot:Example.Org");
  });

  it('does not recover currentSessionKey threads for shared dmScope "main" DMs', async () => {
    const route = await resolveUserRoute({
      cfg: {},
      target: "@alice:example.org",
      currentSessionKey: "agent:main:main:thread:$DmRoot:Example.Org",
    });

    const dmRoute = expectRoute(route);
    expect(dmRoute.sessionKey).toBe("agent:main:main");
    expect(dmRoute.baseSessionKey).toBe("agent:main:main");
    expect(dmRoute.threadId).toBeUndefined();
    expect(dmRoute.recipientSessionExact).toBe(true);
  });
});
