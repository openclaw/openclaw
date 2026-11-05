import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { mintMcpLoopbackClientGrant as MintMcpLoopbackClientGrant } from "../../gateway/mcp-grant-store.js";
import { handleMcpJsonRpc } from "../../gateway/mcp-http.handlers.js";
import {
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "../../gateway/mcp-http.runtime.js";
import { buildMcpToolSchema } from "../../gateway/mcp-http.schema.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { resolveBundleMcpServerInstructions } from "../agent-bundle-mcp-instructions.js";
import {
  readMcpFixtureMessage,
  replyMcpFixtureResult,
  startMcpHttpFixture,
} from "../agent-bundle-mcp-lifecycle.test-support.js";
import { setSessionMcpRuntimeScheduler } from "../agent-bundle-mcp-manager-api.js";
import {
  acquireSessionMcpRuntime,
  disposeAllSessionMcpRuntimes,
  materializeBundleMcpToolsForRun,
} from "../agent-bundle-mcp-tools.js";
import {
  createClaudeMcpCliBackend,
  testing as cliBackendsTesting,
} from "../cli-backends.test-support.js";
import {
  createPersistedCompletionHandoff,
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
} from "../cli-runner.test-helpers.js";
import { createMcpProofPluginRegistry } from "../mcp-connection-resolver.test-fixtures.js";
import { completeMcpOAuthAuthorization, startMcpOAuthAuthorization } from "../mcp-oauth.js";
import { requesterIdentity } from "../mcp-oauth.test-harness.js";
import { saveMcpOAuthAccessTokenForTest } from "../mcp-oauth.test-support.js";
import { resolveMcpTransportConfig } from "../mcp-transport-config.js";
import { getTextContent } from "../test-helpers/agent-tools-fs-helpers.js";
import { mockCliMcpPreparation } from "./prepare-mcp.test-support.js";
import { prepareCliRunContext } from "./prepare.js";
import { resetCliRunnerPrepareTestDeps } from "./prepare.test-support.js";

const PROBE_SERVER_INSTRUCTIONS =
  "PROBE_GUIDANCE: echo one word per call.\n" +
  "x".repeat(2_500) +
  "\nPROBE_TAIL: preserve the complete native guidance.";

const claudeBackend = createClaudeMcpCliBackend();

async function startProbeServer() {
  const state = {
    calls: 0,
    authorizations: [] as string[],
    tokenRequests: 0,
    beforeToken: async () => {},
  };
  const server = await startMcpHttpFixture(async (request, response) => {
    // Minimal authorization server so an expired requester token must refresh.
    const origin = `http://${request.headers.host}`;
    const oauth = request.url?.startsWith("/.well-known/oauth-protected-resource")
      ? { resource: `${origin}/mcp`, authorization_servers: [origin] }
      : request.url === "/.well-known/oauth-authorization-server"
        ? {
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          }
        : request.url === "/register"
          ? { ...(await readMcpFixtureMessage(request)), client_id: "probe-client" }
          : undefined;
    if (request.url === "/token") {
      state.tokenRequests += 1;
      await state.beforeToken();
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ access_token: "refreshed", refresh_token: "r2", token_type: "Bearer" }),
      );
      return;
    }
    if (oauth) {
      response.writeHead(request.url === "/register" ? 201 : 200, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(oauth));
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(request.method === "DELETE" ? 200 : 405).end();
      return;
    }
    const message = await readMcpFixtureMessage<{
      protocolVersion?: string;
      arguments?: { word?: string };
    }>(request);
    if (message.method === "tools/call") {
      state.calls += 1;
      state.authorizations.push(request.headers.authorization ?? "none");
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "probe", version: "1" },
            instructions: PROBE_SERVER_INSTRUCTIONS,
          }
        : message.method === "tools/list"
          ? {
              tools: [
                {
                  name: "echo",
                  description: "Echo a word.",
                  inputSchema: { type: "object", properties: { word: { type: "string" } } },
                },
              ],
            }
          : message.method === "tools/call"
            ? {
                content: [{ type: "text", text: `probe:${message.params?.arguments?.word}` }],
              }
            : undefined;
    if (!result) {
      response.writeHead(202).end();
      return;
    }
    replyMcpFixtureResult(response, message, result);
  });
  return {
    port: new URL(server.url).port,
    url: `${server.url}/mcp`,
    state,
    authorizations: state.authorizations,
    get calls() {
      return state.calls;
    },
    close: server.close,
  };
}

describe("configured MCP servers on CLI turns", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  const mintGrant = vi.fn<typeof MintMcpLoopbackClientGrant>();

  beforeEach(() => {
    mintGrant.mockReset().mockImplementation(createTestMcpLoopbackClientGrant);
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [claudeBackend],
    });
    mockCliMcpPreparation({
      mintMcpLoopbackClientGrant: mintGrant,
      resolveMcpLoopbackPolicyTools,
      resolveMcpLoopbackScopedTools,
    });
    fixture = createCliRunnerPrepareFixture((params) => {
      setRuntimeConfigSnapshot(params.config ?? {});
      return prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params });
    });
  });

  afterEach(async () => {
    await fixture.settle();
    clearRuntimeConfigSnapshot();
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
  });

  it.each(["config", "run"] as const)(
    "bridges configured MCP with a %s-selected node exec host without restricting native tools",
    async (source) => {
      const { sessionTarget } = fixture.session;
      const probeServer = await startProbeServer();
      const scheduler = createTestGatewayScheduler();
      const config: OpenClawConfig = {
        session: { store: sessionTarget.storePath },
        plugins: { enabled: false },
        tools: { exec: { host: source === "config" ? "node" : "gateway" } },
        mcp: {
          servers: {
            probe: {
              transport: "streamable-http",
              url: `http://127.0.0.1:${probeServer.port}/mcp`,
            },
            openclaw: {
              transport: "streamable-http",
              url: `http://127.0.0.1:${probeServer.port}/mcp`,
            },
          },
        },
      };
      try {
        await setSessionMcpRuntimeScheduler(scheduler);
        const context = await fixture.prepare({
          sessionKey: sessionTarget.sessionKey,
          sessionId: sessionTarget.sessionId,
          provider: "claude-cli",
          model: "opus",
          modelHasVision: false,
          sourceReplyDeliveryMode: "automatic",
          config,
          toolOverrides: { mcpServers: { openclaw: false }, webSearch: false },
          ...(source === "run" ? { execOverrides: { host: "node" as const } } : {}),
        });
        try {
          expect(context.params.cliToolAvailability).toBeUndefined();
          expect(context.hostOwnedTools).toBeUndefined();
          const args = context.preparedBackend.backend.args ?? [];
          expect(args[args.indexOf("--disallowedTools") + 1]?.split(",")).toContain("WebSearch");
          const bundle = JSON.parse(
            fs.readFileSync(args[args.indexOf("--mcp-config") + 1] ?? "", "utf-8"),
          ) as { mcpServers: Record<string, unknown> };
          expect(Object.keys(bundle.mcpServers)).toEqual(["openclaw"]);
          const minted = mintGrant.mock.lastCall?.[0];
          expect(minted).toBeDefined();
          const scoped = await resolveMcpLoopbackScopedTools({
            cfg: config,
            context: minted!.context,
            admittedRunContext: context.params.admittedRunContext,
            bundledTools: minted!.bundledTools,
          });
          const probe = scoped.tools.find((tool) => tool.name === "probe__echo");
          expect(scoped.tools.some((tool) => tool.name === "openclaw__echo")).toBe(false);
          expect(probe).toBeDefined();
          expect(getTextContent(await probe!.execute("configured-mcp", { word: "pong" }))).toBe(
            "probe:pong",
          );
          expect(probeServer.calls).toBe(1);
        } finally {
          await context.preparedBackend.cleanup?.();
        }
      } finally {
        await disposeAllSessionMcpRuntimes();
        await scheduler.stop();
        await probeServer.close();
      }
    },
  );

  it.each([
    { name: "allowed", allow: ["read", "probe__*"], deny: [] as string[], childAllow: undefined },
    { name: "denied", allow: ["read", "probe__*"], deny: ["probe__*"], childAllow: undefined },
    { name: "requester-capped", allow: ["read", "probe__*"], deny: [], childAllow: ["read"] },
  ])(
    "serves $name configured MCP servers through the loopback on every turn",
    async ({ allow, deny, childAllow }) => {
      const { sessionTarget } = fixture.session;
      const probeServer = await startProbeServer();
      const childSessionKey = "agent:main:subagent:configured-mcp";
      replaceSessionEntrySync(
        { storePath: sessionTarget.storePath, sessionKey: childSessionKey },
        {
          sessionId: "configured-mcp-child",
          updatedAt: 1,
          spawnedBy: sessionTarget.sessionKey,
          spawnDepth: 1,
          inheritedToolPolicyVersion: 1,
          inheritedToolAllow: childAllow ?? allow,
        },
      );
      const config: OpenClawConfig = {
        session: { store: sessionTarget.storePath },
        plugins: { enabled: false },
        tools: { allow, deny },
        mcp: {
          servers: {
            probe: {
              transport: "streamable-http",
              url: `http://127.0.0.1:${probeServer.port}/mcp`,
            },
          },
        },
      };
      const turns = [];
      const scheduler = createTestGatewayScheduler();
      try {
        await setSessionMcpRuntimeScheduler(scheduler);
        for (const completion of [false, true, false]) {
          const context = await fixture.prepare({
            sessionKey: sessionTarget.sessionKey,
            sessionId: sessionTarget.sessionId,
            provider: "claude-cli",
            model: "opus",
            modelHasVision: false,
            sourceReplyDeliveryMode: "automatic",
            config,
            ...(completion
              ? createPersistedCompletionHandoff(
                  childSessionKey,
                  "configured-mcp-child",
                  sessionTarget,
                )
              : {}),
          });
          try {
            const minted = mintGrant.mock.lastCall?.[0];
            const args = context.preparedBackend.backend.args ?? [];
            const bundle = JSON.parse(
              fs.readFileSync(args[args.indexOf("--mcp-config") + 1] ?? "", "utf-8"),
            ) as { mcpServers: Record<string, unknown> };
            // The CLI never reaches the configured server directly.
            expect(Object.keys(bundle.mcpServers)).toEqual(["openclaw"]);
            const scoped = minted
              ? await resolveMcpLoopbackScopedTools({
                  cfg: config,
                  context: minted.context,
                  admittedRunContext: context.params.admittedRunContext,
                  ...(minted.bundledTools ? { bundledTools: minted.bundledTools } : {}),
                })
              : { tools: [] };
            const probe = scoped.tools.find((tool) => tool.name === "probe__echo");
            const initialized = (await handleMcpJsonRpc({
              message: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
              tools: scoped.tools,
              toolSchema: buildMcpToolSchema(scoped.tools),
              serverInstructions: resolveBundleMcpServerInstructions(
                minted?.bundledTools,
                new Set(buildMcpToolSchema(scoped.tools).map((entry) => entry.name)),
              ),
            })) as { result: { instructions?: string } };
            turns.push({
              toolsAllow: minted?.context.toolsAllow?.toSorted(),
              listed: scoped.tools.map((tool) => tool.name).toSorted(),
              instructions: initialized.result.instructions,
              result: probe
                ? getTextContent(await probe.execute("configured-mcp", { word: "pong" }))
                : undefined,
            });
          } finally {
            await context.preparedBackend.cleanup?.();
          }
        }
      } finally {
        await disposeAllSessionMcpRuntimes();
        await scheduler.stop();
        await probeServer.close();
      }
      const expectedTools = deny.length > 0 ? ["read"] : ["probe__echo", "read"];
      expect(turns[0]).toEqual({
        toolsAllow: expectedTools,
        listed: expectedTools,
        // Native Claude saw the server's guidance; the bridge keeps it, unless
        // the server has no listed tools.
        instructions: deny.length > 0 ? undefined : `## probe\n${PROBE_SERVER_INSTRUCTIONS}`,
        result: deny.length > 0 ? undefined : "probe:pong",
      });
      // One catalog for ordinary and completion turns keeps the Claude prefix stable.
      // A capped completion keeps the definition but refuses the call before the server.
      expect(turns[1]).toEqual(
        childAllow
          ? {
              ...turns[0],
              result:
                "probe__echo is not available during a child-completion turn because it is outside the authority carried from its requester. Do not retry probe__echo.",
            }
          : turns[0],
      );
      expect(turns[2]).toEqual(turns[0]);
      expect(probeServer.calls).toBe(deny.length > 0 ? 0 : childAllow ? 2 : 3);
    },
  );
  it.each(["shared", "per-requester OAuth", "resolver"] as const)(
    "binds %s MCP servers to each claude-cli turn's sender with one stable catalog",
    async (mode) => {
      const { sessionTarget } = fixture.session;
      const server = await startProbeServer();
      const registry = createMcpProofPluginRegistry();
      const http = { transport: "streamable-http" as const, url: server.url };
      const notes = {
        shared: { ...http, headers: { Authorization: "Bearer shared" } },
        "per-requester OAuth": {
          ...http,
          auth: "oauth" as const,
          oauth: { identity: "per-requester" as const },
        },
        resolver: { transport: "streamable-http" as const },
      }[mode];
      if (mode === "resolver") {
        // The resolver hands out each requester's own credential; bob has none.
        registry.apiFor("notes-plugin").registerMcpServerConnectionResolver({
          serverName: "notes",
          resolve: async ({ requesterSenderId }) =>
            requesterSenderId === "alice"
              ? { url: server.url, headers: { Authorization: "Bearer alice" } }
              : null,
        });
      }
      if (mode === "per-requester OAuth") {
        await saveMcpOAuthAccessTokenForTest(
          requesterIdentity("notes", server.url, "alice"),
          "alice",
        );
      }
      const config: OpenClawConfig = {
        session: { store: sessionTarget.storePath },
        plugins: { enabled: false },
        tools: { allow: ["read", "notes__*"] },
        mcp: { servers: { notes } },
      };
      const requester = { messageChannel: "telegram", agentAccountId: "bot" } as const;
      const turns: Array<{ listed: string[]; result?: string }> = [];
      const scheduler = createTestGatewayScheduler();
      try {
        await setSessionMcpRuntimeScheduler(scheduler);
        await withPluginRuntimeRegistryScope(registry.registry, async () => {
          // alice, a senderless turn (completion or automation), bob, alice again.
          for (const senderId of ["alice", undefined, "bob", "alice"]) {
            const context = await fixture.prepare({
              sessionKey: sessionTarget.sessionKey,
              sessionId: sessionTarget.sessionId,
              provider: "claude-cli",
              model: "opus",
              modelHasVision: false,
              sourceReplyDeliveryMode: "automatic",
              config,
              ...requester,
              ...(senderId ? { senderId } : {}),
            });
            try {
              const minted = mintGrant.mock.lastCall?.[0];
              const scoped = await resolveMcpLoopbackScopedTools({
                cfg: config,
                context: minted!.context,
                admittedRunContext: context.params.admittedRunContext,
                ...(minted!.bundledTools ? { bundledTools: minted!.bundledTools } : {}),
              });
              const tool = scoped.tools.find((entry) => entry.name.startsWith("notes__"));
              turns.push({
                listed: buildMcpToolSchema(scoped.tools)
                  .map((entry) => JSON.stringify(entry))
                  .toSorted(),
                result: tool
                  ? getTextContent(await tool.execute("echo", { word: "hi" }))
                  : undefined,
              });
            } finally {
              await context.preparedBackend.cleanup?.();
            }
          }
          // The embedded runner acquires the same owner with the turn's sender.
          const embedded = await materializeBundleMcpToolsForRun(
            await acquireSessionMcpRuntime({
              sessionId: "embedded",
              workspaceDir: fixture.session.dir,
              cfg: config,
              requesterSenderId: "alice",
              ...requester,
            }),
          );
          try {
            const tool = embedded.tools.find((entry) => entry.name === "notes__echo");
            expect(tool && getTextContent(await tool.execute("echo", { word: "hi" }))).toBe(
              turns[0]?.result,
            );
          } finally {
            await embedded.dispose();
          }
        });
      } finally {
        await disposeAllSessionMcpRuntimes();
        await scheduler.stop();
        await server.close();
      }
      // Every turn lists the same definitions, so Claude's cached prefix survives.
      for (const turn of turns) {
        expect(turn.listed).toEqual(turns[0]?.listed);
      }
      expect(turns[0]?.listed.some((entry) => entry.includes('"notes__echo"'))).toBe(true);
      if (mode === "shared") {
        expect(turns.map((turn) => turn.result)).toEqual(Array(4).fill("probe:hi"));
        expect(server.authorizations).toEqual(Array(5).fill("Bearer shared"));
        return;
      }
      expect(turns[0]?.result).toBe("probe:hi");
      expect(turns[3]?.result).toBe("probe:hi");
      // No turn borrows another requester's credential.
      expect(turns[1]?.result).toContain("this turn has no verified user");
      expect(turns[2]?.result).toMatch(/not connected|needs requester sign-in/);
      expect(server.authorizations).toEqual(Array(3).fill("Bearer alice"));
    },
  );
  it("stops a requester-scoped call when its grant ends during the token refresh", async () => {
    const { sessionTarget } = fixture.session;
    const server = await startProbeServer();
    const notes = {
      transport: "streamable-http" as const,
      url: server.url,
      auth: "oauth" as const,
    };
    const config: OpenClawConfig = {
      session: { store: sessionTarget.storePath },
      plugins: { enabled: false },
      tools: { allow: ["read", "notes__*"] },
      mcp: { servers: { notes: { ...notes, oauth: { identity: "per-requester" } } } },
    };
    const requester = { messageChannel: "telegram", agentAccountId: "bot", senderId: "alice" };
    // alice signs in through the real OAuth flow, so her refresh needs no new registration.
    const identity = requesterIdentity("notes", server.url, "alice");
    const oauthConfig = resolveMcpTransportConfig("notes", config.mcp!.servers!.notes);
    const redirectUrl = "http://127.0.0.1/oauth/mcp/callback";
    await startMcpOAuthAuthorization(identity, oauthConfig as never, { redirectUrl });
    await completeMcpOAuthAuthorization(identity, oauthConfig as never, { code: "login" });
    const scheduler = createTestGatewayScheduler();
    const results: unknown[] = [];
    try {
      await setSessionMcpRuntimeScheduler(scheduler);
      const context = await fixture.prepare({
        sessionKey: sessionTarget.sessionKey,
        sessionId: sessionTarget.sessionId,
        provider: "claude-cli",
        model: "opus",
        modelHasVision: false,
        sourceReplyDeliveryMode: "automatic",
        config,
        ...requester,
      });
      try {
        const minted = mintGrant.mock.lastCall?.[0];
        const scoped = await resolveMcpLoopbackScopedTools({
          cfg: config,
          context: minted!.context,
          admittedRunContext: context.params.admittedRunContext,
          ...(minted!.bundledTools ? { bundledTools: minted!.bundledTools } : {}),
        });
        // An expired access token makes the next call refresh before any MCP request.
        await saveMcpOAuthAccessTokenForTest(identity, "expired", -60);
        let grantCurrent = true;
        // The grant ends while the token request is in flight.
        server.state.beforeToken = async () => {
          grantCurrent = false;
        };
        for (const id of [1, 2]) {
          results.push(
            await handleMcpJsonRpc({
              message: {
                jsonrpc: "2.0",
                id,
                method: "tools/call",
                params: { name: "notes__echo", arguments: { word: "hi" } },
              },
              tools: scoped.tools,
              toolSchema: buildMcpToolSchema(scoped.tools),
              authorizeToolCall: () => grantCurrent,
            }),
          );
          grantCurrent = true;
        }
      } finally {
        await context.preparedBackend.cleanup?.();
      }
    } finally {
      await disposeAllSessionMcpRuntimes();
      await scheduler.stop();
      await server.close();
    }
    expect(server.state.tokenRequests).toBe(2);
    expect(JSON.stringify(results[0])).toContain("Tool call authorization expired");
    // The refused call never reached the server; the next current grant uses the new token.
    expect(JSON.stringify(results[1])).toContain("probe:hi");
    expect(server.authorizations).toEqual(["Bearer refreshed"]);
  });
});
