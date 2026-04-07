import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./runtime-api.js";
import { resolveMatrixOutboundSessionRoute } from "./session-route.js";

const tempDirs = new Set<string>();

function createTempStore(entries: Record<string, unknown>): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-session-route-"));
  tempDirs.add(tempDir);
  const storePath = path.join(tempDir, "sessions.json");
  fs.writeFileSync(storePath, JSON.stringify(entries), "utf8");
  return storePath;
}

afterEach(() => {
  for (const tempDir of tempDirs) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("resolveMatrixOutboundSessionRoute", () => {
  it("reuses the current DM room session for same-user sends when Matrix DMs are per-room", () => {
    const storePath = createTempStore({
      "agent:main:matrix:channel:!dm:example.org": {
        sessionId: "sess-1",
        updatedAt: Date.now(),
        chatType: "direct",
        origin: {
          chatType: "direct",
          from: "matrix:@alice:example.org",
          to: "room:!dm:example.org",
          accountId: "ops",
        },
        deliveryContext: {
          channel: "matrix",
          to: "room:!dm:example.org",
          accountId: "ops",
        },
      },
    });
    const cfg = {
      session: {
        store: storePath,
      },
      channels: {
        matrix: {
          dm: {
            sessionScope: "per-room",
          },
        },
      },
    } satisfies OpenClawConfig;

    const route = resolveMatrixOutboundSessionRoute({
      cfg,
      agentId: "main",
      accountId: "ops",
      currentSessionKey: "agent:main:matrix:channel:!dm:example.org",
      target: "@alice:example.org",
      resolvedTarget: {
        to: "@alice:example.org",
        kind: "user",
        source: "normalized",
      },
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:matrix:channel:!dm:example.org",
      baseSessionKey: "agent:main:matrix:channel:!dm:example.org",
      peer: { kind: "channel", id: "!dm:example.org" },
      chatType: "direct",
      from: "matrix:@alice:example.org",
      to: "room:!dm:example.org",
    });
  });

  it("falls back to user-scoped routing when the current session is for another DM peer", () => {
    const storePath = createTempStore({
      "agent:main:matrix:channel:!dm:example.org": {
        sessionId: "sess-1",
        updatedAt: Date.now(),
        chatType: "direct",
        origin: {
          chatType: "direct",
          from: "matrix:@bob:example.org",
          to: "room:!dm:example.org",
          accountId: "ops",
        },
        deliveryContext: {
          channel: "matrix",
          to: "room:!dm:example.org",
          accountId: "ops",
        },
      },
    });
    const cfg = {
      session: {
        store: storePath,
      },
      channels: {
        matrix: {
          dm: {
            sessionScope: "per-room",
          },
        },
      },
    } satisfies OpenClawConfig;

    const route = resolveMatrixOutboundSessionRoute({
      cfg,
      agentId: "main",
      accountId: "ops",
      currentSessionKey: "agent:main:matrix:channel:!dm:example.org",
      target: "@alice:example.org",
      resolvedTarget: {
        to: "@alice:example.org",
        kind: "user",
        source: "normalized",
      },
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
      peer: { kind: "direct", id: "@alice:example.org" },
      chatType: "direct",
      from: "matrix:@alice:example.org",
      to: "room:@alice:example.org",
    });
  });

  it("falls back to user-scoped routing when the current session belongs to another Matrix account", () => {
    const storePath = createTempStore({
      "agent:main:matrix:channel:!dm:example.org": {
        sessionId: "sess-1",
        updatedAt: Date.now(),
        chatType: "direct",
        origin: {
          chatType: "direct",
          from: "matrix:@alice:example.org",
          to: "room:!dm:example.org",
          accountId: "ops",
        },
        deliveryContext: {
          channel: "matrix",
          to: "room:!dm:example.org",
          accountId: "ops",
        },
      },
    });
    const cfg = {
      session: {
        store: storePath,
      },
      channels: {
        matrix: {
          dm: {
            sessionScope: "per-room",
          },
        },
      },
    } satisfies OpenClawConfig;

    const route = resolveMatrixOutboundSessionRoute({
      cfg,
      agentId: "main",
      accountId: "support",
      currentSessionKey: "agent:main:matrix:channel:!dm:example.org",
      target: "@alice:example.org",
      resolvedTarget: {
        to: "@alice:example.org",
        kind: "user",
        source: "normalized",
      },
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
      peer: { kind: "direct", id: "@alice:example.org" },
      chatType: "direct",
      from: "matrix:@alice:example.org",
      to: "room:@alice:example.org",
    });
  });

  it("reuses the canonical DM room after user-target outbound metadata overwrites latest to fields", () => {
    const storePath = createTempStore({
      "agent:main:matrix:channel:!dm:example.org": {
        sessionId: "sess-1",
        updatedAt: Date.now(),
        chatType: "direct",
        origin: {
          chatType: "direct",
          from: "matrix:@bob:example.org",
          to: "room:@bob:example.org",
          nativeChannelId: "!dm:example.org",
          nativeDirectUserId: "@alice:example.org",
          accountId: "ops",
        },
        deliveryContext: {
          channel: "matrix",
          to: "room:@bob:example.org",
          accountId: "ops",
        },
        lastTo: "room:@bob:example.org",
        lastAccountId: "ops",
      },
    });
    const cfg = {
      session: {
        store: storePath,
      },
      channels: {
        matrix: {
          dm: {
            sessionScope: "per-room",
          },
        },
      },
    } satisfies OpenClawConfig;

    const route = resolveMatrixOutboundSessionRoute({
      cfg,
      agentId: "main",
      accountId: "ops",
      currentSessionKey: "agent:main:matrix:channel:!dm:example.org",
      target: "@alice:example.org",
      resolvedTarget: {
        to: "@alice:example.org",
        kind: "user",
        source: "normalized",
      },
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:matrix:channel:!dm:example.org",
      baseSessionKey: "agent:main:matrix:channel:!dm:example.org",
      peer: { kind: "channel", id: "!dm:example.org" },
      chatType: "direct",
      from: "matrix:@alice:example.org",
      to: "room:!dm:example.org",
    });
  });

  it("does not reuse the canonical DM room for a different Matrix user after latest metadata drift", () => {
    const storePath = createTempStore({
      "agent:main:matrix:channel:!dm:example.org": {
        sessionId: "sess-1",
        updatedAt: Date.now(),
        chatType: "direct",
        origin: {
          chatType: "direct",
          from: "matrix:@bob:example.org",
          to: "room:@bob:example.org",
          nativeChannelId: "!dm:example.org",
          nativeDirectUserId: "@alice:example.org",
          accountId: "ops",
        },
        deliveryContext: {
          channel: "matrix",
          to: "room:@bob:example.org",
          accountId: "ops",
        },
        lastTo: "room:@bob:example.org",
        lastAccountId: "ops",
      },
    });
    const cfg = {
      session: {
        store: storePath,
      },
      channels: {
        matrix: {
          dm: {
            sessionScope: "per-room",
          },
        },
      },
    } satisfies OpenClawConfig;

    const route = resolveMatrixOutboundSessionRoute({
      cfg,
      agentId: "main",
      accountId: "ops",
      currentSessionKey: "agent:main:matrix:channel:!dm:example.org",
      target: "@bob:example.org",
      resolvedTarget: {
        to: "@bob:example.org",
        kind: "user",
        source: "normalized",
      },
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
      peer: { kind: "direct", id: "@bob:example.org" },
      chatType: "direct",
      from: "matrix:@bob:example.org",
      to: "room:@bob:example.org",
    });
  });

  it("does not reuse a room after the session metadata was overwritten by a non-DM Matrix send", () => {
    const storePath = createTempStore({
      "agent:main:matrix:channel:!dm:example.org": {
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
      },
    });
    const cfg = {
      session: {
        store: storePath,
      },
      channels: {
        matrix: {
          dm: {
            sessionScope: "per-room",
          },
        },
      },
    } satisfies OpenClawConfig;

    const route = resolveMatrixOutboundSessionRoute({
      cfg,
      agentId: "main",
      accountId: "ops",
      currentSessionKey: "agent:main:matrix:channel:!dm:example.org",
      target: "@alice:example.org",
      resolvedTarget: {
        to: "@alice:example.org",
        kind: "user",
        source: "normalized",
      },
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
      peer: { kind: "direct", id: "@alice:example.org" },
      chatType: "direct",
      from: "matrix:@alice:example.org",
      to: "room:@alice:example.org",
    });
  });

  it("uses the effective default Matrix account when accountId is omitted", () => {
    const storePath = createTempStore({
      "agent:main:matrix:channel:!dm:example.org": {
        sessionId: "sess-1",
        updatedAt: Date.now(),
        chatType: "direct",
        origin: {
          chatType: "direct",
          from: "matrix:@alice:example.org",
          to: "room:!dm:example.org",
          accountId: "ops",
        },
        deliveryContext: {
          channel: "matrix",
          to: "room:!dm:example.org",
          accountId: "ops",
        },
      },
    });
    const cfg = {
      session: {
        store: storePath,
      },
      channels: {
        matrix: {
          defaultAccount: "ops",
          accounts: {
            ops: {
              dm: {
                sessionScope: "per-room",
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const route = resolveMatrixOutboundSessionRoute({
      cfg,
      agentId: "main",
      currentSessionKey: "agent:main:matrix:channel:!dm:example.org",
      target: "@alice:example.org",
      resolvedTarget: {
        to: "@alice:example.org",
        kind: "user",
        source: "normalized",
      },
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:matrix:channel:!dm:example.org",
      baseSessionKey: "agent:main:matrix:channel:!dm:example.org",
      peer: { kind: "channel", id: "!dm:example.org" },
      chatType: "direct",
      from: "matrix:@alice:example.org",
      to: "room:!dm:example.org",
    });
  });

  it("reuses the current DM room when stored account metadata is missing", () => {
    const storePath = createTempStore({
      "agent:main:matrix:channel:!dm:example.org": {
        sessionId: "sess-1",
        updatedAt: Date.now(),
        chatType: "direct",
        origin: {
          chatType: "direct",
          from: "matrix:@alice:example.org",
          to: "room:!dm:example.org",
        },
        deliveryContext: {
          channel: "matrix",
          to: "room:!dm:example.org",
        },
      },
    });
    const cfg = {
      session: {
        store: storePath,
      },
      channels: {
        matrix: {
          defaultAccount: "ops",
          accounts: {
            ops: {
              dm: {
                sessionScope: "per-room",
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const route = resolveMatrixOutboundSessionRoute({
      cfg,
      agentId: "main",
      currentSessionKey: "agent:main:matrix:channel:!dm:example.org",
      target: "@alice:example.org",
      resolvedTarget: {
        to: "@alice:example.org",
        kind: "user",
        source: "normalized",
      },
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:matrix:channel:!dm:example.org",
      baseSessionKey: "agent:main:matrix:channel:!dm:example.org",
      peer: { kind: "channel", id: "!dm:example.org" },
      chatType: "direct",
      from: "matrix:@alice:example.org",
      to: "room:!dm:example.org",
    });
  });
});
