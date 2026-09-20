import {
  createDirectoryTestRuntime,
  expectDirectorySurface,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig, OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import { msteamsPlugin } from "./channel.js";
import { resolveMSTeamsOutboundSessionRoute } from "./session-route.js";

const { getConversation } = vi.hoisted(() => ({ getConversation: vi.fn() }));
vi.mock("./conversation-store-state.js", () => ({
  createMSTeamsConversationStoreState: () => ({ get: getConversation }),
}));

const msteamsDirectoryAdapter = msteamsPlugin.directory;

function requireDirectorySelf(): NonNullable<NonNullable<typeof msteamsDirectoryAdapter>["self"]> {
  const directorySelf = msteamsDirectoryAdapter?.self;
  if (!directorySelf) {
    throw new Error("expected msteams directory.self");
  }
  return directorySelf;
}

describe("msteams directory", () => {
  const runtimeEnv = createDirectoryTestRuntime() satisfies RuntimeEnv;
  const directorySelf = requireDirectorySelf();

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("self()", () => {
    it("returns bot identity when credentials are configured", async () => {
      const cfg = {
        channels: {
          msteams: {
            appId: "test-app-id-1234",
            appPassword: "secret",
            tenantId: "tenant-id-5678",
          },
        },
      } satisfies OpenClawConfig;

      const result = await directorySelf({ cfg, runtime: runtimeEnv });
      expect(result).toEqual({ kind: "user", id: "test-app-id-1234", name: "test-app-id-1234" });
    });

    it("returns null when credentials are not configured", async () => {
      vi.stubEnv("MSTEAMS_APP_ID", "");
      vi.stubEnv("MSTEAMS_APP_PASSWORD", "");
      vi.stubEnv("MSTEAMS_TENANT_ID", "");
      const cfg = { channels: {} } satisfies OpenClawConfig;
      const result = await directorySelf({ cfg, runtime: runtimeEnv });
      expect(result).toBeNull();
    });
  });

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        msteams: {
          allowFrom: [" alice ", " user:Bob "],
          dms: { " carol ": {}, "user:bob": {} },
          teams: {
            team1: {
              channels: {
                "conversation:chan1": {},
                chan2: {},
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const directory = expectDirectorySurface(msteamsDirectoryAdapter);

    const peers = await directory.listPeers({
      cfg,
      query: undefined,
      limit: undefined,
      runtime: runtimeEnv,
    });
    expect(peers).toStrictEqual([
      { kind: "user", id: "user:alice" },
      { kind: "user", id: "user:Bob" },
      { kind: "user", id: "user:carol" },
      { kind: "user", id: "user:bob" },
    ]);

    const groups = await directory.listGroups({
      cfg,
      query: undefined,
      limit: undefined,
      runtime: runtimeEnv,
    });
    expect(groups).toStrictEqual([
      { kind: "group", id: "conversation:chan1" },
      { kind: "group", id: "conversation:chan2" },
    ]);
  });
});

describe("msteams session route", () => {
  beforeEach(() => getConversation.mockReset().mockResolvedValue(null));
  it("builds direct routes for explicit user targets", async () => {
    const route = await resolveMSTeamsOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "msteams:01234567-89ab-cdef-0123-456789abcdef",
    });

    expect(route?.peer).toEqual({
      kind: "direct",
      id: "01234567-89ab-cdef-0123-456789abcdef",
    });
    expect(route?.from).toBe("msteams:01234567-89ab-cdef-0123-456789abcdef");
    expect(route?.to).toBe("user:01234567-89ab-cdef-0123-456789abcdef");
    expect(route?.recipientSessionExact).toBe(true);
  });

  it("does not claim display-name user targets as canonical sessions", async () => {
    const route = await resolveMSTeamsOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "msteams:user:Alice Example",
      resolvedTarget: { to: "user:Alice Example", kind: "user", source: "directory" },
    });

    expect(route?.recipientSessionExact).toBe(false);
  });

  it("builds channel routes for thread conversations and strips suffix metadata", async () => {
    const route = await resolveMSTeamsOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "teams:19:abc123@thread.tacv2;messageid=42",
    });

    expect(route?.peer).toEqual({ kind: "channel", id: "19:abc123@thread.tacv2" });
    expect(route?.from).toBe("msteams:channel:19:abc123@thread.tacv2");
    expect(route?.to).toBe("conversation:19:abc123@thread.tacv2");
    expect(route?.sessionKey).toBe("agent:main:msteams:channel:19:abc123@thread.tacv2:thread:42");
    expect(route?.threadId).toBe("42");
    expect(route?.recipientSessionExact).toBe(true);
  });

  it("does not claim an exact channel session without its thread root", async () => {
    const route = await resolveMSTeamsOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "teams:19:abc123@thread.tacv2",
    });

    expect(route?.sessionKey).toBe("agent:main:msteams:channel:19:abc123@thread.tacv2");
    expect(route?.recipientSessionExact).toBe(false);
  });

  it.each([
    { target: "19:abc123@thread.tacv2", threadId: undefined },
    { target: "19:abc123@thread.tacv2;messageid=42", threadId: "42" },
    { target: "team-aad-id/19:abc123@thread.tacv2;messageid=42", threadId: "42" },
  ])(
    "shares channel sessions while preserving destination $target",
    async ({ target, threadId }) => {
      const route = await msteamsPlugin.messaging?.resolveOutboundSessionRoute?.({
        cfg: { channels: { msteams: { threadSessionPolicy: "channel" } } },
        agentId: "main",
        target,
      });
      expect(route).toMatchObject({
        peer: { kind: "channel", id: "19:abc123@thread.tacv2" },
        sessionKey: "agent:main:msteams:channel:19:abc123@thread.tacv2",
        recipientSessionExact: true,
      });
      expect(route?.threadId).toBe(threadId);
      expect(getConversation).not.toHaveBeenCalled();
    },
  );

  it.each<{
    title: string;
    teams: NonNullable<MSTeamsConfig["teams"]>;
    expectedPolicy: "thread" | "channel";
  }>([
    {
      title: "team-only policy with no channel entries",
      teams: { "team-1": { threadSessionPolicy: "channel" as const } },
      expectedPolicy: "channel",
    },
    {
      title: "exact channel overrides team policy",
      teams: {
        "team-1": {
          threadSessionPolicy: "channel" as const,
          channels: { "19:abc123@thread.tacv2": { threadSessionPolicy: "thread" as const } },
        },
      },
      expectedPolicy: "thread",
    },
    {
      title: "wildcard channel overrides team policy",
      teams: {
        "team-1": {
          threadSessionPolicy: "thread" as const,
          channels: { "*": { threadSessionPolicy: "channel" as const } },
        },
      },
      expectedPolicy: "channel",
    },
    {
      title: "exact team hides unrelated wildcard channel policy",
      teams: {
        "team-1": { threadSessionPolicy: "thread" as const },
        "*": { channels: { "*": { threadSessionPolicy: "channel" as const } } },
      },
      expectedPolicy: "thread",
    },
  ])("resolves stored ownership for $title", async ({ teams, expectedPolicy }) => {
    getConversation.mockResolvedValue({ teamId: "team-1" });
    const route = await msteamsPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: { channels: { msteams: { teams } } },
      agentId: "main",
      target: "19:abc123@thread.tacv2",
      threadId: "42",
    });
    expect(getConversation).toHaveBeenCalledWith("19:abc123@thread.tacv2");
    expect(route?.sessionKey).toBe(
      `agent:main:msteams:channel:19:abc123@thread.tacv2${expectedPolicy === "thread" ? ":thread:42" : ""}`,
    );
    expect(route?.threadId).toBe("42");
    expect(route?.recipientSessionExact).toBe(true);
  });

  it("marks a bare channel exact under its stored team's shared policy", async () => {
    getConversation.mockResolvedValue({ teamId: "team-1" });
    const route = await msteamsPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {
        channels: { msteams: { teams: { "team-1": { threadSessionPolicy: "channel" } } } },
      },
      agentId: "main",
      target: "19:abc123@thread.tacv2",
    });
    expect(route).toMatchObject({
      sessionKey: "agent:main:msteams:channel:19:abc123@thread.tacv2",
      recipientSessionExact: true,
    });
    expect(route?.threadId).toBeUndefined();
  });

  it("does not infer team ownership from another team's wildcard channel", async () => {
    const route = await msteamsPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {
        channels: {
          msteams: {
            teams: { "other-team": { channels: { "*": { threadSessionPolicy: "channel" } } } },
          },
        },
      },
      agentId: "main",
      target: "19:abc123@thread.tacv2",
    });
    expect(route?.recipientSessionExact).toBe(false);
  });

  it("does not load conversation state for allowlist-only team configuration", async () => {
    const route = await msteamsPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: { channels: { msteams: { teams: { "team-1": { channels: { "*": {} } } } } } },
      agentId: "main",
      target: "19:abc123@thread.tacv2;messageid=42",
    });
    expect(route?.sessionKey).toBe("agent:main:msteams:channel:19:abc123@thread.tacv2:thread:42");
    expect(getConversation).not.toHaveBeenCalled();
  });

  it.each(["19:legacy@thread.skype", "team-id/19:legacy@thread.skype"])(
    "uses stored channel type for scoped policy on %s",
    async (target) => {
      getConversation.mockResolvedValue({
        teamId: "team-1",
        conversation: { conversationType: "channel" },
      });
      const route = await msteamsPlugin.messaging?.resolveOutboundSessionRoute?.({
        cfg: {
          channels: { msteams: { teams: { "team-1": { threadSessionPolicy: "channel" } } } },
        },
        agentId: "main",
        target,
        threadId: "42",
      });
      expect(getConversation).toHaveBeenCalledWith("19:legacy@thread.skype");
      expect(route).toMatchObject({
        peer: { kind: "channel", id: "19:legacy@thread.skype" },
        sessionKey: "agent:main:msteams:channel:19:legacy@thread.skype",
        recipientSessionExact: true,
        threadId: "42",
      });
    },
  );

  it.each(["channel", "groupChat", undefined])(
    "uses stored %s type for legacy targets under global channel policy",
    async (conversationType) => {
      getConversation.mockResolvedValue(
        conversationType ? { teamId: "team-1", conversation: { conversationType } } : null,
      );
      const route = await msteamsPlugin.messaging?.resolveOutboundSessionRoute?.({
        cfg: { channels: { msteams: { threadSessionPolicy: "channel" } } },
        agentId: "main",
        target: "19:legacy@thread.skype",
      });
      const kind = conversationType === "channel" ? "channel" : "group";
      expect(route).toMatchObject({
        peer: { kind, id: "19:legacy@thread.skype" },
        sessionKey: `agent:main:msteams:${kind}:19:legacy@thread.skype`,
        recipientSessionExact: conversationType === "channel",
      });
    },
  );

  it("does not load state or change legacy target inference without a session policy", async () => {
    const route = await msteamsPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: { channels: { msteams: { teams: { "team-1": { channels: { "*": {} } } } } } },
      agentId: "main",
      target: "19:legacy@thread.skype",
    });
    expect(route?.peer).toEqual({ kind: "group", id: "19:legacy@thread.skype" });
    expect(getConversation).not.toHaveBeenCalled();
  });

  it("returns group routes for non-user, non-channel conversations", async () => {
    const route = await resolveMSTeamsOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "msteams:conversation:19:groupchat",
    });

    expect(route?.peer).toEqual({ kind: "group", id: "19:groupchat" });
    expect(route?.from).toBe("msteams:group:19:groupchat");
    expect(route?.to).toBe("conversation:19:groupchat");
    expect(route?.recipientSessionExact).toBe(false);
  });

  it("returns null when the target cannot be normalized", async () => {
    expect(
      await resolveMSTeamsOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        accountId: "default",
        target: "msteams:",
      }),
    ).toBeNull();
  });
});
