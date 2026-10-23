import type { App } from "@slack/bolt";
import { WebAPIPlatformError, WebAPIRateLimitedError, WebAPIRequestError } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as runtimeEnv from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSlackRuntime } from "../runtime.js";
import type { SlackEventScope } from "./event-scope.js";
import { createMonitorTestContext } from "./monitor-context.test-support.js";

const saveRemoteMediaMock = vi.hoisted(() => vi.fn());
const logVerboseMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  logVerbose: logVerboseMock,
}));

vi.mock("./media.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media.runtime.js")>()),
  saveRemoteMedia: saveRemoteMediaMock,
}));

function createTestContext({
  dmScope = "main",
  appClient,
  ...overrides
}: {
  dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  groupDmEnabled?: boolean;
  groupDmChannels?: string[];
  appClient?: App["client"];
  runtime?: RuntimeEnv;
  apiAppId?: string;
  channelsConfig?: Record<string, { enabled?: boolean }>;
} = {}) {
  return createMonitorTestContext({
    cfg: { channels: { slack: { enabled: true } }, session: { dmScope } } as OpenClawConfig,
    app: { client: appClient ?? {} } as App,
    ...overrides,
  });
}

function installAgentViewStore(register = vi.fn(), lookup = vi.fn()) {
  const openKeyedStore = vi.fn(() => ({ register, lookup }));
  installAgentViewRuntime(openKeyedStore);
  return openKeyedStore;
}

function installAgentViewRuntime(openKeyedStore: ReturnType<typeof vi.fn>) {
  setSlackRuntime({
    state: { openKeyedStore },
    logging: { getChildLogger: () => ({ warn: vi.fn() }) },
  } as never);
}

function createStoredAgentViews() {
  const stored = new Map<string, { experience: "agent" | "managed-thread"; observedAt: number }>();
  const register = vi.fn(
    async (key: string, value: { experience: "agent" | "managed-thread"; observedAt: number }) => {
      stored.set(key, value);
    },
  );
  const lookup = vi.fn(async (key: string) => stored.get(key));
  const openKeyedStore = installAgentViewStore(register, lookup);
  return { register, lookup, openKeyedStore };
}

function userContext(profile: Record<string, string>, slackApiUrl?: string) {
  const usersInfo = vi.fn().mockResolvedValue({ user: { profile } });
  const ctx = createTestContext({
    appClient: {
      users: { info: usersInfo },
      ...(slackApiUrl ? { slackApiUrl } : {}),
    } as unknown as App["client"],
  });
  return { ctx, usersInfo };
}

function channelContext(info: ReturnType<typeof vi.fn>) {
  return createTestContext({ appClient: { conversations: { info } } as unknown as App["client"] });
}

function createEnterpriseEventScope(teamId: string): SlackEventScope {
  return {
    teamId,
    client: {} as SlackEventScope["client"],
  };
}

const stateKey = (kind: string, appId = "A_EXPECTED", ...thread: string[]) =>
  JSON.stringify([kind, "default", "T_EXPECTED", appId, ...thread]);
const threadKey = (ts = "10.000") => stateKey("thread", "A_EXPECTED", "D123", ts);
const observation = (experience: string) => ({ experience, observedAt: expect.any(Number) });
const storeOptions = (namespace: string) => ({ namespace, maxEntries: 4096 });
const statusUpdate = { channelId: "D123", threadTs: "10.000", status: "processing" as const };
function statusContext(
  apiCall = vi.fn().mockResolvedValue({ ok: true }),
  log?: ReturnType<typeof vi.fn>,
) {
  const ctx = createTestContext({
    appClient: { apiCall } as unknown as App["client"],
    runtime: log ? ({ log } as unknown as RuntimeEnv) : ({} as RuntimeEnv),
  });
  return { ctx, apiCall };
}

async function expectViews(ctx: ReturnType<typeof createTestContext>, enabled: boolean) {
  await expect(ctx.isSlackAgentView()).resolves.toBe(enabled);
  await expect(ctx.isSlackManagedViewThread("D123", "10.000")).resolves.toBe(enabled);
}

const avatar = (size: number) => `https://avatars.slack-edge.com/user-hash-${size}.png`;

beforeEach(() => {
  setSlackRuntime(null as never);
  saveRemoteMediaMock.mockReset();
  logVerboseMock.mockClear();
});
afterEach(() => setSlackRuntime(null as never));

describe("Slack monitor context", () => {
  it("drops mismatched nested team.id payloads used by interaction bodies", () => {
    const ctx = createTestContext();
    expect(
      ["T_WRONG", "T_EXPECTED"].map((id) =>
        ctx.shouldDropMismatchedSlackEvent({ api_app_id: "A_EXPECTED", team: { id } }),
      ),
    ).toEqual([true, false]);
  });

  it("normalizes channel-prefixed group DM allowlist entries", () => {
    const ctx = createTestContext({ groupDmEnabled: true, groupDmChannels: ["channel:G456"] });

    expect(ctx.isChannelAllowed({ channelId: "G456", channelType: "mpim" })).toBe(true);
    expect(ctx.isChannelAllowed({ channelId: "G999", channelType: "mpim" })).toBe(false);
  });

  it("matches workspace-qualified channel and group DM policies", () => {
    const ctx = createTestContext({
      groupDmEnabled: true,
      groupDmChannels: ["team:T11111111:channel:G01234567"],
      channelsConfig: {
        "team:T11111111:channel:C01234567": { enabled: true },
        "team:T22222222:channel:C01234567": { enabled: false },
      },
    });

    const allowed = (teamId: string, channelType: "channel" | "mpim") =>
      ctx.isChannelAllowed({
        teamId,
        channelId: channelType === "channel" ? "C01234567" : "G01234567",
        channelType,
      });
    expect([
      allowed("T11111111", "channel"),
      allowed("T22222222", "channel"),
      allowed("T11111111", "mpim"),
      allowed("T22222222", "mpim"),
    ]).toEqual([true, false, true, false]);
  });

  it("routes channel-less direct interactions to the sender session", async () => {
    const ctx = createTestContext({ dmScope: "per-channel-peer" });
    expect(
      await ctx.resolveSlackSystemEventRoute({ channelType: "im", senderId: "U_SHORTCUT" }),
    ).toEqual({ agentId: "main", sessionKey: "agent:main:slack:direct:u_shortcut" });
  });

  it.each([
    [
      "channel",
      "C_SHARED",
      "U_ACTOR",
      "agent:main:slack:channel:team:t111:channel:c_shared",
      "agent:main:slack:channel:team:t222:channel:c_shared",
    ],
    [
      "im",
      "D_SHARED",
      "U_SHARED",
      "agent:main:main:account:default:team:t111",
      "agent:main:main:account:default:team:t222",
    ],
  ] as const)(
    "partitions enterprise %s events by workspace",
    async (channelType, channelId, senderId, first, second) => {
      const ctx = createTestContext({ dmScope: "main" });
      const route = (teamId: string) =>
        ctx.resolveSlackSystemEventRoute({
          channelType,
          channelId,
          senderId,
          eventScope: createEnterpriseEventScope(teamId),
        });
      expect(await route("T111")).toEqual({ agentId: "main", sessionKey: first });
      expect(await route("T222")).toEqual({ agentId: "main", sessionKey: second });
    },
  );

  it.each([
    [new WebAPIRateLimitedError(1), "rate_limited"],
    [new WebAPIPlatformError({ ok: false, error: "channel_not_found" }), "not_found"],
    [new WebAPIPlatformError({ ok: false, error: "missing_scope" }), "permission"],
    [new WebAPIRequestError(new Error("private network payload")), "network"],
    [
      new WebAPIRequestError(
        new Error(
          "A rate limit was exceeded (url: https://slack.com/api/conversations.info, retry-after: 1)",
        ),
      ),
      "rate_limited",
    ],
  ])("returns only a closed lookup failure category for %s", async (error, category) => {
    const info = vi.fn().mockRejectedValue(error);
    const ctx = channelContext(info);

    const resolved = await ctx.resolveChannelName("C123");

    expect(info).toHaveBeenCalledOnce();
    expect(resolved).toEqual({ lookupFailureCategory: category });
    expect(JSON.stringify(resolved)).not.toContain("private provider payload");
  });

  it("fills metadata after an event stored only the authoritative type", async () => {
    const info = vi.fn().mockResolvedValue({
      channel: { id: "C0MPDM42", name: "team-chat", topic: { value: "planning" } },
    });
    const ctx = channelContext(info);
    ctx.rememberSlackChannelType("C0MPDM42", "mpim");

    await expect(ctx.resolveChannelName("C0MPDM42")).resolves.toEqual({
      name: "team-chat",
      type: "mpim",
      topic: "planning",
      purpose: undefined,
    });
    await ctx.resolveChannelName("C0MPDM42");
    expect(info).toHaveBeenCalledOnce();
  });

  it("isolates remembered types by enterprise team scope", async () => {
    const createScope = (teamId: string): SlackEventScope =>
      ({
        teamId,
        client: {
          conversations: { info: vi.fn().mockRejectedValue(new Error("missing_scope")) },
        },
      }) as unknown as SlackEventScope;
    const ctx = createTestContext();
    const firstTeam = createScope("T_FIRST");
    const secondTeam = createScope("T_SECOND");
    ctx.rememberSlackChannelType("C0SHARED", "mpim", firstTeam);

    await expect(ctx.resolveChannelName("C0SHARED", firstTeam)).resolves.toMatchObject({
      type: "mpim",
    });
    expect(await ctx.resolveChannelName("C0SHARED", secondTeam)).toEqual({
      lookupFailureCategory: "other",
    });
    expect(await ctx.resolveChannelName("C0SHARED")).toEqual({ lookupFailureCategory: "other" });
  });

  it("keeps a recently re-resolved user while older entries are evicted", async () => {
    const usersInfo = vi.fn().mockImplementation(async ({ user }: { user: string }) => ({
      user: { profile: { display_name: `name-${user}` } },
    }));
    const ctx = createTestContext({
      appClient: { users: { info: usersInfo } } as unknown as App["client"],
    });
    await ctx.resolveUserName("U0KEEP");
    for (let index = 0; index < 2047; index += 1) {
      await ctx.resolveUserName(`U${index}`);
    }
    // Refresh recency before the insertion that evicts the oldest entry.
    await ctx.resolveUserName("U0KEEP");
    await ctx.resolveUserName("U_NEW");
    const before = usersInfo.mock.calls.length;
    await expect(ctx.resolveUserName("U0KEEP")).resolves.toEqual({ name: "name-U0KEEP" });
    expect(usersInfo).toHaveBeenCalledTimes(before);
    await ctx.resolveUserName("U0");
    expect(usersInfo).toHaveBeenCalledTimes(before + 1);
  });

  it("downloads the cached DM profile image without blocking or attaching the bot token", async () => {
    const download = createDeferred<{ path: string }>();
    saveRemoteMediaMock.mockReturnValue(download.promise);
    const { ctx, usersInfo } = userContext({
      display_name: "Alice",
      image_192: avatar(192),
      image_512: avatar(512),
      image_72: avatar(72),
    });

    await expect(ctx.resolveUserName("U1")).resolves.toEqual({
      name: "Alice",
      imageUrl: avatar(192),
    });
    expect(ctx.resolveUserAvatar("U1")).toBeUndefined();
    expect(ctx.resolveUserAvatar("U1")).toBeUndefined();
    expect(saveRemoteMediaMock).toHaveBeenCalledExactlyOnceWith({
      url: avatar(192),
      filePathHint: "conversation-avatar.png",
      maxBytes: 256 * 1024,
      ssrfPolicy: {
        allowedHostnames: ["avatars.slack-edge.com", "*.slack-edge.com"],
        hostnameAllowlist: ["avatars.slack-edge.com", "*.slack-edge.com"],
      },
    });

    download.resolve({ path: "/media/inbound/slack-avatar.png" });
    await vi.waitFor(() =>
      expect(ctx.resolveUserAvatar("U1")).toBe("/media/inbound/slack-avatar.png"),
    );
    await ctx.resolveUserName("U1");
    expect(usersInfo).toHaveBeenCalledTimes(1);
  });

  it("skips profile image downloads for GovSlack clients", async () => {
    const { ctx } = userContext(
      {
        display_name: "Gov User",
        image_192: "https://avatars.slack-edge.com/gov-user.png",
      },
      "https://slack-gov.com/api/",
    );

    await ctx.resolveUserName("U_GOV");

    expect(ctx.resolveUserAvatar("U_GOV")).toBeUndefined();
    expect(saveRemoteMediaMock).not.toHaveBeenCalled();
  });

  it.each(["installed later", "open fails once"] as const)(
    "keeps namespace stores separate and reuses successful opens when runtime is %s",
    async (mode) => {
      const workspace = { register: vi.fn(), lookup: vi.fn(async () => undefined) };
      const thread = { register: vi.fn(), lookup: vi.fn(async () => undefined) };
      const stores = { "agent-view-workspaces": workspace, "agent-view-threads": thread };
      const attempts = new Map<string, number>();
      const openKeyedStore = vi.fn(({ namespace }: { namespace: keyof typeof stores }) => {
        const count = (attempts.get(namespace) ?? 0) + 1;
        attempts.set(namespace, count);
        if (mode === "open fails once" && count === 1) {
          throw new Error("sqlite unavailable");
        }
        return stores[namespace];
      });
      const installRuntime = () => setSlackRuntime({ state: { openKeyedStore } } as never);
      const warn = vi.fn();
      const logger = vi.spyOn(runtimeEnv, "getChildLogger").mockReturnValue({ warn } as never);
      try {
        if (mode !== "installed later") {
          installRuntime();
        }
        const ctx = createTestContext();
        await expectViews(ctx, false);
        installRuntime();
        await expectViews(ctx, false);

        setSlackRuntime(null as never);
        await ctx.recordSlackAgentView();
        await ctx.recordSlackAgentView();
        await ctx.recordSlackManagedViewThread("D123", "10.000");
        await ctx.recordSlackManagedViewThread("D123", "20.000");

        expect(workspace.lookup).toHaveBeenCalledExactlyOnceWith(stateKey("workspace"));
        expect(workspace.register).toHaveBeenCalledExactlyOnceWith(
          stateKey("workspace"),
          observation("agent"),
        );
        expect(thread.lookup).toHaveBeenCalledExactlyOnceWith(threadKey());
        expect(thread.register.mock.calls).toEqual(
          ["10.000", "20.000"].map((ts) => [threadKey(ts), observation("managed-thread")]),
        );
        const expectedOpens = mode === "open fails once" ? 2 : 1;
        const namespaces = ["agent-view-workspaces", "agent-view-threads"];
        expect([...attempts]).toEqual(namespaces.map((namespace) => [namespace, expectedOpens]));
        expect(openKeyedStore.mock.calls.map(([options]) => options)).toEqual(
          Array.from({ length: expectedOpens }, () => namespaces.map(storeOptions)).flat(),
        );
        expect(warn).toHaveBeenCalledTimes(mode === "open fails once" ? 1 : 0);
      } finally {
        logger.mockRestore();
      }
    },
  );

  it.each(["workspace", "thread"] as const)(
    "persists %s views without enabling unrelated scopes",
    async (kind) => {
      const { register, lookup, openKeyedStore } = createStoredAgentViews();
      const first = createTestContext();
      if (kind === "workspace") {
        await first.recordSlackAgentView();
      } else {
        await first.recordSlackManagedViewThread("D123", "10.000");
      }
      const restarted = createTestContext();
      const key = kind === "workspace" ? stateKey("workspace") : threadKey();
      const experience = kind === "workspace" ? "agent" : "managed-thread";
      expect(register).toHaveBeenCalledWith(key, observation(experience));
      expect(openKeyedStore).toHaveBeenCalledWith(
        storeOptions(kind === "workspace" ? "agent-view-workspaces" : "agent-view-threads"),
      );
      if (kind === "workspace") {
        await expect(restarted.isSlackAgentView()).resolves.toBe(true);
        expect(lookup).toHaveBeenCalledWith(key);
        await expect(
          createTestContext({ apiAppId: "A_REPLACEMENT" }).isSlackAgentView(),
        ).resolves.toBe(false);
        expect(lookup).toHaveBeenCalledWith(stateKey("workspace", "A_REPLACEMENT"));
      } else {
        await expect(restarted.isSlackManagedViewThread("D123", "10.000")).resolves.toBe(true);
        await expect(restarted.isSlackManagedViewThread("D123", "20.000")).resolves.toBe(false);
        expect(lookup).toHaveBeenCalledWith(key);
      }
    },
  );

  it("retries managed view persistence after a transient write failure", async () => {
    const register = vi
      .fn()
      .mockRejectedValueOnce(new Error("sqlite busy"))
      .mockResolvedValue(undefined);
    installAgentViewStore(register);
    const ctx = createTestContext();

    await ctx.recordSlackManagedViewThread("D123", "10.000");
    await ctx.recordSlackManagedViewThread("D123", "10.000");

    expect(register).toHaveBeenCalledTimes(2);
  });

  it("reads the durable Agent View marker once the app id is learned", async () => {
    const lookup = vi.fn(async () => ({ experience: "agent", observedAt: 1 }));
    installAgentViewStore(vi.fn(), lookup);
    const ctx = createTestContext({ apiAppId: "" });

    await expect(ctx.isSlackAgentView()).resolves.toBe(false);
    expect(lookup).not.toHaveBeenCalled();

    ctx.apiAppId = "A_LEARNED";
    await expect(ctx.isSlackAgentView()).resolves.toBe(true);
    expect(lookup).toHaveBeenCalledWith(stateKey("workspace", "A_LEARNED"));
  });

  it("does not persist Agent View without a stable Slack app identity", async () => {
    const register = vi.fn();
    const lookup = vi.fn();
    installAgentViewStore(register, lookup);

    const ctx = createTestContext({ apiAppId: "" });
    await ctx.recordSlackAgentView();
    await ctx.recordSlackManagedViewThread("D123", "10.000");
    await expectViews(ctx, true);
    expect(register).not.toHaveBeenCalled();

    const restarted = createTestContext({ apiAppId: "" });
    await expectViews(restarted, false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("keeps event-derived Agent View when persistent state cannot open", async () => {
    installAgentViewRuntime(
      vi.fn(() => {
        throw new Error("sqlite unavailable");
      }),
    );
    const ctx = createTestContext();

    await ctx.recordSlackAgentView();

    await expect(ctx.isSlackAgentView()).resolves.toBe(true);
  });

  it("writes processing status only for a thread", async () => {
    const { ctx, apiCall } = statusContext();
    await ctx.setSlackSessionStatus({ ...statusUpdate, threadTs: undefined });
    expect(apiCall).not.toHaveBeenCalled();
    await ctx.setSlackSessionStatus(statusUpdate);
    expect(apiCall).toHaveBeenCalledExactlyOnceWith("agents.sessions.setStatus", {
      token: "xoxb-test",
      channel_id: "D123",
      thread_ts: "10.000",
      status: "processing",
    });
  });

  it("warns operators only once across contexts for a missing Stop subscription", async () => {
    const warning = "missing_agent_session_stopped_event_subscription";
    const log = vi.fn();
    const apiCall = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, response_metadata: { warnings: [warning] } })
      .mockResolvedValue({ ok: true, warning });
    for (let i = 0; i < 3; i++) {
      const { ctx } = statusContext(apiCall, log);
      await ctx.setSlackSessionStatus(statusUpdate);
    }
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        "https://docs.openclaw.ai/channels/slack#additional-manifest-settings",
      ),
    );
  });

  it("keeps API failures verbose and retries a title only after successful delivery", async () => {
    const apiCall = vi
      .fn()
      .mockRejectedValueOnce(new Error("not_agent_app"))
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("rename failed"))
      .mockResolvedValue({ ok: true });
    const log = vi.fn();
    const { ctx } = statusContext(apiCall, log);
    const update = { ...statusUpdate, title: "Research" };
    for (let attempt = 0; attempt < 4; attempt++) {
      await ctx.setSlackSessionStatus(update);
    }
    expect(
      apiCall.mock.calls.filter(([method]) => method === "agents.sessions.rename"),
    ).toHaveLength(2);
    expect(log).not.toHaveBeenCalled();
    expect(logVerboseMock).toHaveBeenCalledWith(expect.stringContaining("not_agent_app"));
    expect(logVerboseMock).toHaveBeenCalledWith(expect.stringContaining("rename failed"));
  });

  it("does not overwrite a user rename received during a status request", async () => {
    const statusReply = createDeferred<{ ok: boolean }>();
    const apiCall = vi
      .fn()
      .mockReturnValueOnce(statusReply.promise)
      .mockResolvedValue({ ok: true });
    const { ctx } = statusContext(apiCall);
    const pending = ctx.setSlackSessionStatus({ ...statusUpdate, title: "Old title" });
    ctx.recordSlackSessionTitle({ ...statusUpdate, title: "User title" });
    statusReply.resolve({ ok: true });
    await pending;
    await ctx.setSlackSessionStatus({ ...statusUpdate, title: "User title" });
    expect(apiCall.mock.calls.map(([method]) => method)).toEqual([
      "agents.sessions.setStatus",
      "agents.sessions.setStatus",
    ]);
  });

  it("evicts old title records without mixing threads or workspace clients", async () => {
    const apiCall = vi.fn().mockResolvedValue({ ok: true });
    const ctx = createTestContext();
    const eventScope = { teamId: "T_OTHER", client: { apiCall } as unknown as App["client"] };
    const update = { ...statusUpdate, title: "Title", eventScope };
    ctx.recordSlackSessionTitle(update);
    for (let i = 0; i < 1024; i++) {
      ctx.recordSlackSessionTitle({ ...update, threadTs: String(i) });
    }
    await ctx.setSlackSessionStatus(update);
    expect(apiCall).toHaveBeenLastCalledWith(
      "agents.sessions.rename",
      expect.objectContaining({ thread_ts: "10.000", title: "Title" }),
    );
    ctx.recordSlackSessionTitle({
      ...update,
      eventScope: undefined,
      title: "Workspace-local title",
    });
    await ctx.setSlackSessionStatus(update);
    expect(
      apiCall.mock.calls.filter(([method]) => method === "agents.sessions.rename"),
    ).toHaveLength(1);
  });
});
