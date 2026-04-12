import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./runtime-api.js";
import { resolveMatrixOutboundSessionRoute } from "./session-route.js";

const tempDirs = new Set<string>();
const currentDmSessionKey = "agent:main:matrix:channel:!dm:example.org";
type MatrixChannelConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["matrix"]>;

const perRoomDmMatrixConfig = {
  dm: {
    sessionScope: "per-room",
  },
} satisfies MatrixChannelConfig;

const defaultAccountPerRoomDmMatrixConfig = {
  defaultAccount: "ops",
  accounts: {
    ops: {
      dm: {
        sessionScope: "per-room",
      },
    },
  },
} satisfies MatrixChannelConfig;

function createTempStore(entries: Record<string, unknown>): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-session-route-"));
  tempDirs.add(tempDir);
  const storePath = path.join(tempDir, "sessions.json");
  fs.writeFileSync(storePath, JSON.stringify(entries), "utf8");
  return storePath;
}

function createMatrixRouteConfig(
  entries: Record<string, unknown>,
  matrix: MatrixChannelConfig = perRoomDmMatrixConfig,
): OpenClawConfig {
  return {
    session: {
      store: createTempStore(entries),
    },
    channels: {
      matrix,
    },
  } satisfies OpenClawConfig;
}

function createStoredDirectDmSession(
  params: {
    from?: string;
    to?: string;
    accountId?: string | null;
    nativeChannelId?: string;
    nativeDirectUserId?: string;
    lastTo?: string;
    lastAccountId?: string;
  } = {},
): Record<string, unknown> {
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
    origin: {
      chatType: "direct",
      from: params.from ?? "matrix:@alice:example.org",
      to,
      ...nativeMetadata,
      ...accountMetadata,
    },
    deliveryContext: {
      channel: "matrix",
      to,
      ...accountMetadata,
    },
    ...(params.lastTo ? { lastTo: params.lastTo } : {}),
    ...(params.lastAccountId ? { lastAccountId: params.lastAccountId } : {}),
  };
}

function createStoredChannelSession(): Record<string, unknown> {
  return {
    sessionId: "sess-1",
    updatedAt: Date.now(),
    chatType: "channel",
    origin: {
      chatType: "channel",
      from: "matrix:channel:!ops:example.org",
      to: "room:!ops:example.org",
      nativeChannelId: "!ops:example.org",
      nativeDirectUserId: "@alice:example.org",
      accountId: "ops",
    },
    deliveryContext: {
      channel: "matrix",
      to: "room:!ops:example.org",
      accountId: "ops",
    },
    lastTo: "room:!ops:example.org",
    lastAccountId: "ops",
  };
}

function resolveUserRoute(params: { cfg: OpenClawConfig; accountId?: string; target?: string }) {
  const target = params.target ?? "@alice:example.org";
  return resolveMatrixOutboundSessionRoute({
    cfg: params.cfg,
    agentId: "main",
    ...(params.accountId ? { accountId: params.accountId } : {}),
    currentSessionKey: currentDmSessionKey,
    target,
    resolvedTarget: {
      to: target,
      kind: "user",
      source: "normalized",
    },
  });
}

function expectCurrentDmRoomRoute(route: ReturnType<typeof resolveMatrixOutboundSessionRoute>) {
  expect(route).toMatchObject({
    sessionKey: currentDmSessionKey,
    baseSessionKey: currentDmSessionKey,
    peer: { kind: "channel", id: "!dm:example.org" },
    chatType: "direct",
    from: "matrix:@alice:example.org",
    to: "room:!dm:example.org",
  });
}

function expectFallbackUserRoute(
  route: ReturnType<typeof resolveMatrixOutboundSessionRoute>,
  params?: {
    userId?: string;
  },
) {
  const userId = params?.userId ?? "@alice:example.org";
  expect(route).toMatchObject({
    sessionKey: "agent:main:main",
    baseSessionKey: "agent:main:main",
    peer: { kind: "direct", id: userId },
    chatType: "direct",
    from: `matrix:${userId}`,
    to: `room:${userId}`,
  });
}

afterEach(() => {
  for (const tempDir of tempDirs) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("resolveMatrixOutboundSessionRoute", () => {
  it("reuses the current DM room session for same-user sends when Matrix DMs are per-room", () => {
    const cfg = createMatrixRouteConfig({
      [currentDmSessionKey]: createStoredDirectDmSession(),
    });

    const route = resolveUserRoute({
      cfg,
      accountId: "ops",
    });

    expectCurrentDmRoomRoute(route);
  });

  it("falls back to user-scoped routing when the current session is for another DM peer", () => {
    const cfg = createMatrixRouteConfig({
      [currentDmSessionKey]: createStoredDirectDmSession({ from: "matrix:@bob:example.org" }),
    });

    const route = resolveUserRoute({
      cfg,
      accountId: "ops",
    });

    expectFallbackUserRoute(route);
  });

  it("falls back to user-scoped routing when the current session belongs to another Matrix account", () => {
    const cfg = createMatrixRouteConfig({
      [currentDmSessionKey]: createStoredDirectDmSession(),
    });

    const route = resolveUserRoute({
      cfg,
      accountId: "support",
    });

    expectFallbackUserRoute(route);
  });

  it("reuses the canonical DM room after user-target outbound metadata overwrites latest to fields", () => {
    const cfg = createMatrixRouteConfig({
      [currentDmSessionKey]: createStoredDirectDmSession({
        from: "matrix:@bob:example.org",
        to: "room:@bob:example.org",
        nativeChannelId: "!dm:example.org",
        nativeDirectUserId: "@alice:example.org",
        lastTo: "room:@bob:example.org",
        lastAccountId: "ops",
      }),
    });

    const route = resolveUserRoute({
      cfg,
      accountId: "ops",
    });

    expectCurrentDmRoomRoute(route);
  });

  it("does not reuse the canonical DM room for a different Matrix user after latest metadata drift", () => {
    const cfg = createMatrixRouteConfig({
      [currentDmSessionKey]: createStoredDirectDmSession({
        from: "matrix:@bob:example.org",
        to: "room:@bob:example.org",
        nativeChannelId: "!dm:example.org",
        nativeDirectUserId: "@alice:example.org",
        lastTo: "room:@bob:example.org",
        lastAccountId: "ops",
      }),
    });

    const route = resolveUserRoute({
      cfg,
      accountId: "ops",
      target: "@bob:example.org",
    });

    expectFallbackUserRoute(route, { userId: "@bob:example.org" });
  });

  it("does not reuse a room after the session metadata was overwritten by a non-DM Matrix send", () => {
    const cfg = createMatrixRouteConfig({
      [currentDmSessionKey]: createStoredChannelSession(),
    });

    const route = resolveUserRoute({
      cfg,
      accountId: "ops",
    });

    expectFallbackUserRoute(route);
  });

  it("uses the effective default Matrix account when accountId is omitted", () => {
    const cfg = createMatrixRouteConfig(
      {
        [currentDmSessionKey]: createStoredDirectDmSession(),
      },
      defaultAccountPerRoomDmMatrixConfig,
    );

    const route = resolveUserRoute({
      cfg,
    });

    expectCurrentDmRoomRoute(route);
  });

  it("reuses the current DM room when stored account metadata is missing", () => {
    const cfg = createMatrixRouteConfig(
      {
        [currentDmSessionKey]: createStoredDirectDmSession({ accountId: null }),
      },
      defaultAccountPerRoomDmMatrixConfig,
    );

    const route = resolveUserRoute({
      cfg,
    });

    expectCurrentDmRoomRoute(route);
  });
});
