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
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { resolveBundleMcpServerInstructions } from "../agent-bundle-mcp-instructions.js";
import {
  readMcpFixtureMessage,
  replyMcpFixtureResult,
  startMcpHttpFixture,
} from "../agent-bundle-mcp-lifecycle.test-support.js";
import { setSessionMcpRuntimeScheduler } from "../agent-bundle-mcp-manager-api.js";
import { disposeAllSessionMcpRuntimes } from "../agent-bundle-mcp-tools.js";
import {
  createClaudeMcpCliBackend,
  testing as cliBackendsTesting,
} from "../cli-backends.test-support.js";
import {
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
} from "../cli-runner.test-helpers.js";
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
  const state = { calls: 0 };
  const server = await startMcpHttpFixture(async (request, response) => {
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
              ? {
                  trustedInternalHandoff: {
                    kind: "subagent-completion" as const,
                    sourceSessionKey: childSessionKey,
                    sourceSessionId: "configured-mcp-child",
                    targetSessionKey: sessionTarget.sessionKey,
                    targetSessionId: sessionTarget.sessionId,
                    provider: "claude-cli",
                    model: "opus",
                  },
                  inputProvenance: {
                    kind: "inter_session" as const,
                    sourceTool: "subagent_announce",
                    sourceSessionKey: childSessionKey,
                  },
                }
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
});
