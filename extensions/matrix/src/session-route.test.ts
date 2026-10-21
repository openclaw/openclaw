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
  const accountMetadata = accountId ? { accountId } : {};
  const nativeMetadata = {
    ...(params.nativeChannelId ? { nativeChannelId: params.nativeChannelId } : {}),
    ...(params.nativeDirectUserId ? { nativeDirectUserId: params.nativeDirectUserId } : {}),
  };
  return {
    sessionId: "sess-1",
    updatedAt: Date.now(),
    chatType,
    delivery: normalizeSessionDeliveryState({
      origin: {
        chatType,
        from: params.from ?? "matrix:@alice:example.org",
        to,
        ...nativeMetadata,
        ...accountMetadata,
      },
      context: { channel: "matrix", to, ...accountMetadata },
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

describe("resolveMatrixOutboundSessionRoute", () => {
  const driftedSession = () =>
    createStoredDirectDmSession({
      from: "matrix:@bob:example.org",
      to: "room:@bob:example.org",
      nativeChannelId: "!dm:example.org",
      nativeDirectUserId: "@alice:example.org",
    });
  it.each([
    ["another account", createStoredDirectDmSession, "support", false],
    ["canonical peer after metadata drift", driftedSession, "ops", true],
    ["different peer after metadata drift", driftedSession, "ops", false, "@bob:example.org"],
    [
      "non-DM metadata",
      () =>
        createStoredDirectDmSession({
          chatType: "channel",
          from: "matrix:channel:!ops:example.org",
          to: "room:!ops:example.org",
          nativeChannelId: "!ops:example.org",
          nativeDirectUserId: "@alice:example.org",
        }),
      "ops",
      false,
    ],
    [
      "missing account metadata",
      () => createStoredDirectDmSession({ accountId: null }),
      undefined,
      true,
      undefined,
      { defaultAccount: "ops", accounts: { ops: perRoomDmMatrixConfig } },
    ],
  ] as const)("routes %s", async (_name, session, accountId, reuse, requestedTarget, matrix) => {
    const target = requestedTarget ?? "@alice:example.org";
    const route = await resolveUserRoute({
      cfg: await createMatrixRouteConfig(session(), matrix),
      accountId,
      target,
    });
    const sessionKey = reuse ? currentDmSessionKey : "agent:main:main";
    expect(route).toMatchObject({
      sessionKey,
      baseSessionKey: sessionKey,
      peer: reuse ? { kind: "channel", id: "!dm:example.org" } : { kind: "direct", id: target },
      chatType: "direct",
      from: `matrix:${target}`,
      to: `room:${reuse ? "!dm:example.org" : target}`,
      recipientSessionExact: reuse,
    });
  });

  it("uses the Matrix thread root when replying to a child event", async () => {
    const threadId = "$ThreadRoot:Example.Org";
    const route = await resolveMatrixOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "room:!ops:example.org",
      threadId,
      replyToId: "$ReplyChild:Example.Org",
    });
    expect(route).toMatchObject({
      threadId,
      sessionKey: `agent:main:matrix:channel:!ops:example.org:thread:${threadId}`,
    });
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

    expect(threadedRoute).toMatchObject({
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

    expect(route).toMatchObject({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
      recipientSessionExact: true,
    });
    expect(route?.threadId).toBeUndefined();
  });
});
