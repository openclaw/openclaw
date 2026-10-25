import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionMcpRuntimeManager,
  makeManagerRuntime,
} from "./agent-bundle-mcp-manager.test-support.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import type { CreateSessionMcpRuntime } from "./agent-bundle-mcp-runtime-shared.js";
import type {
  McpToolCatalog,
  SessionMcpRuntime,
  SessionMcpRuntimeLease,
} from "./agent-bundle-mcp-types.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  runUntilCompleted,
} from "./code-mode.test-support.js";
import { requesterMcpOAuthIdentity } from "./mcp-oauth-identity.js";

const oauthStatus = vi.hoisted(() => vi.fn());
const startAuthorization = vi.hoisted(() => vi.fn());
const toolCalls: string[] = [];
let advertiseResourcesAndPrompts = false;
const authorizationUrl = "https://auth.example/authorize?state=opaque";
const unavailableContent = [
  { type: "text", text: expect.stringContaining("This turn will continue without MCP tools") },
];
const toolSurface = (tools: Parameters<typeof runConnect>[0]) =>
  tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
const request = {
  sessionId: "session-connect",
  workspaceDir: "/workspace",
  requesterSenderId: "alice",
  cfg: {
    mcp: {
      servers: {
        calendar: {
          url: "https://mcp.example/rpc",
          transport: "streamable-http" as const,
          auth: "oauth" as const,
          oauth: { identity: "per-requester" as const },
        },
      },
    },
  },
};

function runConnect(tools: Parameters<typeof applyCodeModeCatalog>[0]["tools"], code: string) {
  const harness = createCodeModeHarness();
  applyCodeModeCatalog({ ...harness, tools: [...harness.tools, ...tools] });
  return runUntilCompleted({ execTool: harness.tools[0]!, waitTool: harness.tools[1]!, code });
}

function guestText(text: string, isError = false) {
  return { content: [{ type: "text", text: expect.stringContaining(text) }], isError };
}

vi.mock("./mcp-oauth.js", () => ({
  readMcpOAuthCredentialsStatuses: oauthStatus,
  startMcpOAuthAuthorization: startAuthorization,
}));

function createTestRuntime(params: Parameters<CreateSessionMcpRuntime>[0]): SessionMcpRuntime {
  const server = { serverName: "calendar", safeServerName: "calendar" };
  const catalog: McpToolCatalog = { version: 1, generatedAt: 1, servers: {}, tools: [] };
  if (params.includeServerNames?.has("calendar")) {
    catalog.servers.calendar = {
      ...server,
      launchSummary: "calendar",
      toolCount: 1,
      ...(advertiseResourcesAndPrompts ? { resources: {}, prompts: {} } : {}),
    };
    catalog.tools.push({
      ...server,
      toolName: "events",
      fallbackDescription: "List events",
      inputSchema: { type: "object", properties: {} },
    });
  }
  return makeManagerRuntime(params, catalog, {
    isRequesterScopedServer: () => params.requesterScope !== undefined,
    peekCatalog: () => catalog,
    callTool: async (_serverName, toolName) => {
      toolCalls.push(toolName);
      return { content: [{ type: "text", text: `called:${toolName}` }], isError: false };
    },
    listResources: async () => {
      toolCalls.push("resources_list");
      return { resources: [] };
    },
    readResource: async (_serverName, uri) => {
      toolCalls.push(`resources_read:${uri}`);
      return { contents: [] };
    },
    listPrompts: async () => {
      toolCalls.push("prompts_list");
      return { prompts: [] };
    },
    getPrompt: async (_serverName, name) => {
      toolCalls.push(`prompts_get:${name}`);
      return { messages: [] };
    },
  });
}

describe("requester MCP connect runtime", () => {
  let manager: ReturnType<typeof createSessionMcpRuntimeManager>;
  const created: Array<Parameters<CreateSessionMcpRuntime>[0]> = [];

  beforeEach(() => {
    oauthStatus.mockReset().mockResolvedValue([{ state: "unauthenticated" }]);
    startAuthorization.mockReset().mockResolvedValue({ status: "redirect", authorizationUrl });
    created.length = 0;
    toolCalls.length = 0;
    advertiseResourcesAndPrompts = false;
    manager = createSessionMcpRuntimeManager({
      createRuntime: (params) => {
        created.push(params);
        return createTestRuntime(params);
      },
    });
  });

  afterEach(async () => {
    await manager.disposeAll();
    await resetCodeModeTestState();
  });

  it("materializes connect before authorization and real tools on the next message", async () => {
    const input = {
      ...request,
      messageChannel: "telegram",
      agentAccountId: "bot",
      cfg: { ...request.cfg, gateway: { publicOrigin: "https://gateway.example" } },
    };
    const disconnectedRuntime = await manager.getOrCreate(input);
    const disconnected = await materializeBundleMcpToolsForRun({ runtime: disconnectedRuntime });
    expect(disconnected.tools.map((tool) => tool.name)).toEqual(["calendar__connect"]);
    expect(created.find((params) => params.requesterScope)?.includeServerNames).toEqual(new Set());
    expect(startAuthorization).not.toHaveBeenCalled();
    const connecting = disconnected.tools[0]!.execute("connect", {});
    expect(startAuthorization).toHaveBeenCalledOnce();
    await expect(connecting).resolves.toMatchObject({
      details: { mcpConnect: { serverName: "calendar", authorizationUrl } },
    });
    startAuthorization
      .mockResolvedValueOnce({ status: "redirect", authorizationUrl })
      .mockResolvedValueOnce({ status: "authorized" });
    const guest = await runConnect(
      disconnected.tools,
      "return { signIn: await MCP.calendar.connect(), connected: await MCP.calendar.connect() };",
    );
    expect(guest.status, JSON.stringify(guest)).toBe("completed");
    expect(guest.value).toEqual({
      signIn: guestText(authorizationUrl),
      connected: guestText('"calendar" is connected'),
    });
    expect(disconnected.tools[0]?.resultContentSource).toBe("network");
    await disconnected.dispose();

    oauthStatus.mockResolvedValue([{ state: "authorized" }]);
    const connectedRuntime = await manager.getOrCreate(input);
    const connected = await materializeBundleMcpToolsForRun({ runtime: connectedRuntime });

    expect(connected.tools.map((tool) => tool.name)).toEqual(["calendar__events"]);
    expect(created.findLast((params) => params.requesterScope)?.includeServerNames).toEqual(
      new Set(["calendar"]),
    );
    await connected.dispose();
  });

  it("signs each verified Gateway profile in separately through one backend sender", async () => {
    const authorized = new Set<string>();
    oauthStatus.mockImplementation(async (identities: Array<{ storeKey: string }>) =>
      identities.map(({ storeKey }) => ({
        state: authorized.has(storeKey) ? "authorized" : "unauthenticated",
      })),
    );
    startAuthorization.mockImplementation(async ({ storeKey }: { storeKey: string }) => ({
      status: "redirect",
      authorizationUrl: `https://auth.example/authorize?state=${storeKey}`,
    }));
    // A backend Gateway client is the transport sender of every person it brings in.
    const turn = (profileId?: string) => ({
      ...request,
      requesterSenderId: "gateway-client",
      messageChannel: "webchat",
      requesterProfile: profileId ? { profileId, assertCurrent() {} } : undefined,
      cfg: { ...request.cfg, gateway: { publicOrigin: "https://gateway.example" } },
    });
    const toolNames = async (requesterProfileId?: string) => {
      const runtime = await manager.getOrCreate(turn(requesterProfileId));
      const materialized = await materializeBundleMcpToolsForRun({ runtime });
      const names = materialized.tools.map((tool) => tool.name);
      await materialized.dispose();
      return names;
    };
    const signIn = async (requesterProfileId?: string) => {
      const runtime = await manager.getOrCreate(turn(requesterProfileId));
      const materialized = await materializeBundleMcpToolsForRun({ runtime });
      expect(materialized.tools.map((tool) => tool.name)).toEqual(["calendar__connect"]);
      const result = await materialized.tools[0]!.execute("connect", {});
      await materialized.dispose();
      return (result.details as { mcpConnect: { authorizationUrl: string } }).mcpConnect
        .authorizationUrl;
    };
    // MCP Apps key a profile the same way, so one sign-in serves both surfaces.
    const storeKey = (requesterSenderId: string) =>
      requesterMcpOAuthIdentity("calendar", "https://mcp.example/rpc", {
        requesterSenderId,
        messageChannel: "webchat",
      }).storeKey;

    expect([await signIn("profile-a"), await signIn("profile-b"), await signIn()]).toEqual([
      `https://auth.example/authorize?state=${storeKey("profile-a")}`,
      `https://auth.example/authorize?state=${storeKey("profile-b")}`,
      `https://auth.example/authorize?state=${storeKey("gateway-client")}`,
    ]);
    expect(
      new Set([storeKey("profile-a"), storeKey("profile-b"), storeKey("gateway-client")]).size,
    ).toBe(3);

    authorized.add(storeKey("profile-a"));
    expect(await toolNames("profile-a")).toEqual(["calendar__events"]);
    expect(await toolNames("profile-b")).toEqual(["calendar__connect"]);
    expect(await toolNames()).toEqual(["calendar__connect"]);
  });

  it("selects no requester credentials once a profile loses the run's authority", async () => {
    oauthStatus.mockResolvedValue([{ state: "authorized" }]);
    const revoked = new Error("operator authority revoked");
    await expect(
      manager.getOrCreate({
        ...request,
        requesterSenderId: "gateway-client",
        messageChannel: "webchat",
        requesterProfile: {
          profileId: "profile-a",
          assertCurrent: () => {
            throw revoked;
          },
        },
      }),
    ).rejects.toBe(revoked);
    // Neither the profile's credentials nor the shared backend sender's were opened.
    expect(created.filter((params) => params.requesterScope)).toEqual([]);
    expect(oauthStatus).not.toHaveBeenCalled();
  });

  it("refuses a profile's retained tools once it loses the run's authority", async () => {
    let current = true;
    const requesterProfile = {
      profileId: "profile-a",
      assertCurrent: () => {
        if (!current) {
          throw new Error("operator authority revoked");
        }
      },
    };
    const materialize = async () =>
      await materializeBundleMcpToolsForRun({
        ...(await manager.acquire({
          ...request,
          requesterSenderId: "gateway-client",
          messageChannel: "webchat",
          requesterProfile,
          cfg: { ...request.cfg, gateway: { publicOrigin: "https://gateway.example" } },
        })),
        assertRequesterCurrent: requesterProfile.assertCurrent,
      });
    const signIn = await materialize();
    oauthStatus.mockResolvedValue([{ state: "authorized" }]);
    const connected = await materialize();
    expect(signIn.tools.map((tool) => tool.name)).toEqual(["calendar__connect"]);
    expect(connected.tools.map((tool) => tool.name)).toEqual(["calendar__events"]);

    // Tools the turn already holds recheck the profile right before each credentialed call.
    current = false;
    await expect(connected.tools[0]!.execute("events", {})).rejects.toThrow("revoked");
    await expect(signIn.tools[0]!.execute("connect", {})).rejects.toThrow("revoked");
    expect(toolCalls).toEqual([]);
    expect(startAuthorization).not.toHaveBeenCalled();
    current = true;
    await expect(connected.tools[0]!.execute("events", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "called:events" }],
    });
    await signIn.dispose();
    await connected.dispose();
  });

  it("refuses a profile's retained resource and prompt reads once it loses the run's authority", async () => {
    advertiseResourcesAndPrompts = true;
    oauthStatus.mockResolvedValue([{ state: "authorized" }]);
    let current = true;
    const requesterProfile = {
      profileId: "profile-a",
      assertCurrent: () => {
        if (!current) {
          throw new Error("operator authority revoked");
        }
      },
    };
    const connected = await materializeBundleMcpToolsForRun({
      ...(await manager.acquire({
        ...request,
        requesterSenderId: "gateway-client",
        messageChannel: "webchat",
        requesterProfile,
      })),
      assertRequesterCurrent: requesterProfile.assertCurrent,
    });
    const reads = [
      ["resources_list", {}],
      ["resources_read", { uri: "calendar://today" }],
      ["prompts_list", {}],
      ["prompts_get", { name: "agenda" }],
    ] as const;
    const read = (operation: string, input: object) =>
      connected.tools
        .find((tool) => tool.name === `calendar__${operation}`)!
        .execute(operation, input);

    // Utility executors read with the profile's credentials too, so they recheck it first.
    current = false;
    for (const [operation, input] of reads) {
      await expect(read(operation, input)).rejects.toThrow("revoked");
    }
    expect(toolCalls).toEqual([]);
    current = true;
    for (const [operation, input] of reads) {
      await read(operation, input);
    }
    expect(toolCalls).toEqual([
      "resources_list",
      "resources_read:calendar://today",
      "prompts_list",
      "prompts_get:agenda",
    ]);
    await connected.dispose();
  });

  it("carries a profile's authority into the sign-in it starts", async () => {
    let current = true;
    const requesterProfile = {
      profileId: "profile-a",
      assertCurrent: () => {
        if (!current) {
          throw new Error("operator authority revoked");
        }
      },
    };
    // The OAuth owner rechecks its login lifecycle before each network and store effect; the person loses access
    // while the sign-in waits on its lease or the provider.
    startAuthorization.mockImplementation(
      async (_identity: unknown, _config: unknown, opts: { login?: { assertCurrent(): void } }) => {
        opts.login?.assertCurrent();
        current = false;
        opts.login?.assertCurrent();
        return { status: "redirect", authorizationUrl };
      },
    );
    const signIn = await materializeBundleMcpToolsForRun({
      ...(await manager.acquire({
        ...request,
        requesterSenderId: "gateway-client",
        messageChannel: "webchat",
        requesterProfile,
        cfg: { ...request.cfg, gateway: { publicOrigin: "https://gateway.example" } },
      })),
      assertRequesterCurrent: requesterProfile.assertCurrent,
    });
    const call = new AbortController();
    await expect(signIn.tools[0]!.execute("connect", {}, call.signal)).rejects.toThrow("revoked");
    expect(startAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ principal: "requester", serverName: "calendar" }),
      expect.anything(),
      expect.objectContaining({
        redirectUrl: "https://gateway.example/oauth/mcp/callback",
        login: expect.objectContaining({ signal: call.signal }),
      }),
    );
    await signIn.dispose();
  });

  it.each(
    ["embedded", "requester"].flatMap((consumer) =>
      ["none", "removal", "origin", "retirement"].map((change) => ({ consumer, change })),
    ),
  )(
    "keeps refused sign-in schemas unavailable after $change ($consumer)",
    async ({ consumer, change }) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const held: SessionMcpRuntimeLease[] = [];
      try {
        const input = {
          ...request,
          cfg: {
            ...request.cfg,
            mcp: {
              servers: {
                ...request.cfg.mcp.servers,
                mail: { ...request.cfg.mcp.servers.calendar, url: "https://mail.example/mcp" },
              },
            },
            gateway: { publicOrigin: "https://gateway.example" },
          },
        };
        oauthStatus.mockResolvedValue([{ state: "authorized" }, { state: "unauthenticated" }]);
        const acquire = async () =>
          consumer === "embedded"
            ? await manager.acquire(input)
            : (await manager.acquireRequesterScoped(input))!;
        const first = await materializeBundleMcpToolsForRun(await acquire());
        const surface = toolSurface(first.tools);
        expect(surface.map((tool) => tool.name)).toEqual(["calendar__events", "mail__connect"]);
        await first.dispose();
        for (let index = 0; index < 256; index++) {
          held.push(
            await manager.acquire({
              sessionId: `busy-${index}`,
              workspaceDir: "/workspace",
              cfg: { mcp: { servers: { fixture: { command: "true" } } } },
            }),
          );
        }
        const count = created.length;
        const refused = await materializeBundleMcpToolsForRun(await acquire());
        expect(toolSurface(refused.tools)).toEqual(surface);
        expect((await refused.tools[0]!.execute("refused", {})).content).toEqual(
          unavailableContent,
        );
        expect(created).toHaveLength(count);
        expect(startAuthorization).not.toHaveBeenCalled();
        const connect = refused.tools[1]!.execute;
        if (change === "removal") {
          await manager.reloadConfig({
            cfg: { ...input.cfg, mcp: { servers: { calendar: input.cfg.mcp.servers.calendar } } },
          });
        } else if (change === "origin") {
          await manager.reloadConfig({
            cfg: { ...input.cfg, gateway: { publicOrigin: "https://replacement.example" } },
          });
        } else if (change === "retirement") {
          await manager.disposeSession(input.sessionId);
        }
        const result = await connect("connect", {});
        expect(startAuthorization).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          details: { status: "error", mcpServer: "mail", mcpTool: "connect" },
          content: unavailableContent,
        });
        await refused.dispose();
      } finally {
        held.forEach((lease) => lease.releaseLease());
        vi.useRealTimers();
      }
    },
  );

  it("returns requester connection configuration failures as failed MCP guest results", async () => {
    const runtime = await manager.getOrCreate({
      ...request,
      sessionId: "session-connect-missing-origin",
    });
    const materialized = await materializeBundleMcpToolsForRun({ runtime });
    const direct = await materialized.tools[0]!.execute("connect-direct", {});
    expect(direct.details).toMatchObject({ status: "error", mcpServer: "calendar" });
    expect(startAuthorization).not.toHaveBeenCalled();

    const guest = await runConnect(materialized.tools, "return await MCP.calendar.connect();");
    expect(guest.status, JSON.stringify(guest)).toBe("completed");
    expect(guest.value).toEqual(guestText("gateway.publicOrigin", true));
    expect(guest.value).not.toHaveProperty("details");
    await materialized.dispose();
  });
});
