import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureCatalog } from "./agent-bundle-mcp-fixture.test-support.js";
import {
  createSessionMcpRuntimeManager,
  makeManagerRuntime,
} from "./agent-bundle-mcp-manager.test-support.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import type { CreateSessionMcpRuntime } from "./agent-bundle-mcp-runtime-shared.js";
import type { SessionMcpRuntimeLease } from "./agent-bundle-mcp-types.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  runUntilCompleted,
} from "./code-mode.test-support.js";

const oauthStatus = vi.hoisted(() => vi.fn());
const startAuthorization = vi.hoisted(() => vi.fn());
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

function createTestRuntime(params: Parameters<CreateSessionMcpRuntime>[0]) {
  const catalog = params.includeServerNames?.has("calendar")
    ? fixtureCatalog("calendar", [{ toolName: "events", fallbackDescription: "List events" }], 1)
    : { version: 1, generatedAt: 1, servers: {}, tools: [] };
  return makeManagerRuntime(params, catalog, {
    peekCatalog: () => catalog,
  });
}

describe("requester MCP connect runtime", () => {
  let manager: ReturnType<typeof createSessionMcpRuntimeManager>;

  beforeEach(() => {
    oauthStatus.mockReset().mockResolvedValue([{ state: "unauthenticated" }]);
    startAuthorization.mockReset().mockResolvedValue({ status: "redirect", authorizationUrl });
    manager = createSessionMcpRuntimeManager({ createRuntime: createTestRuntime });
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
    expect(startAuthorization).not.toHaveBeenCalled();
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
    await connected.dispose();
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
        const refused = await materializeBundleMcpToolsForRun(await acquire());
        expect(toolSurface(refused.tools)).toEqual(surface);
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
