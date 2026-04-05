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
});
