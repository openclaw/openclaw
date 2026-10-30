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

async function createMatrixRouteConfig(
  entry: SessionEntry,
  matrix: MatrixChannelConfig = perRoomDmMatrixConfig,
): Promise<OpenClawConfig> {
  const tempDir = tempDirs.make("case-", sessionRoot);
  const storePath = path.join(tempDir, "sessions.json");
  await upsertSessionEntry({ sessionKey: currentDmSessionKey, storePath, entry });
  return {
    session: { store: storePath },
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
    chatType?: "direct" | "channel";
  } = {},
): SessionEntry {
  const accountId = params.accountId === null ? undefined : (params.accountId ?? "ops");
  const to = params.to ?? "room:!dm:example.org";
  const chatType = params.chatType ?? "direct";
  return {
    sessionId: "sess-1",
    updatedAt: Date.now(),
    chatType,
    delivery: normalizeSessionDeliveryState({
      origin: {
        ...params,
        accountId,
        chatType,
        from: params.from ?? "matrix:@alice:example.org",
        to,
      },
      context: { channel: "matrix", to, accountId },
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
    accountId: params.accountId,
    currentSessionKey: params.currentSessionKey ?? currentDmSessionKey,
    target,
    resolvedTarget: { to: target, kind: "user", source: "normalized" },
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
  it.each([
    {
      name: "another account",
      session: createStoredDirectDmSession,
      accountId: "support",
      reuse: false,
    },
    {
      name: "canonical peer after metadata drift",
      session: driftedSession,
      accountId: "ops",
      reuse: true,
    },
    {
      name: "different peer after metadata drift",
      session: driftedSession,
      accountId: "ops",
      target: "@bob:example.org",
      reuse: false,
    },
    {
      name: "non-DM metadata",
      session: () =>
        createStoredDirectDmSession({
          chatType: "channel",
          from: "matrix:channel:!ops:example.org",
          to: "room:!ops:example.org",
          nativeChannelId: "!ops:example.org",
          nativeDirectUserId: "@alice:example.org",
        }),
      accountId: "ops",
      reuse: false,
    },
    {
      name: "missing account metadata",
      session: () => createStoredDirectDmSession({ accountId: null }),
      matrix: { defaultAccount: "ops", accounts: { ops: perRoomDmMatrixConfig } },
      reuse: true,
    },
  ])("routes $name", async ({ session, matrix, accountId, target, reuse }) => {
    const route = await resolveUserRoute({
      cfg: await createMatrixRouteConfig(session(), matrix),
      accountId,
      target,
    });
    if (reuse) {
      expectCurrentDmRoomRoute(route);
    } else {
      expectFallbackUserRoute(route, { userId: target });
    }
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
      cfg: await createMatrixRouteConfig(createStoredDirectDmSession()),
      accountId: "ops",
      currentSessionKey: `${currentDmSessionKey}:thread:$DmRoot:Example.Org`,
    });

    expect(expectRoute(threadedRoute)).toMatchObject({
      sessionKey: `${currentDmSessionKey}:thread:$DmRoot:Example.Org`,
      baseSessionKey: currentDmSessionKey,
      to: "room:!dm:example.org",
      threadId: "$DmRoot:Example.Org",
    });
  });

  it('does not recover currentSessionKey threads for shared dmScope "main" DMs', async () => {
    const route = await resolveUserRoute({
      cfg: {},
      target: "@alice:example.org",
      currentSessionKey: "agent:main:main:thread:$DmRoot:Example.Org",
    });

    expect(expectRoute(route)).toMatchObject({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
      recipientSessionExact: true,
    });
    expect(route?.threadId).toBeUndefined();
  });
});
