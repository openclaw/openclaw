import { it } from "vitest";
import { createPackedSdkConsumer } from "./package.e2e.test-support.js";

it("packs an external consumer that uses only the exported entrypoint and a custom transport", async () => {
  const consumer = await createPackedSdkConsumer();
  try {
    await consumer.typecheck(`
        import type {
          AgentsCreateParams, AgentsDeleteParams, AgentsUpdateParams,
          ArtifactSummary, ArtifactsDownloadResult, GatewayArtifactSummary,
          EnvironmentSummary, EnvironmentsListResult, SessionCreateParams, SessionSendParams,
          ToolsEffectiveParams, ToolInvokeParams, ToolInvokeResult,
          WorkerEnvironmentMetadata, WorkerEnvironmentState, WorkerTunnelStatus,
        } from "@openclaw/sdk";
        import type * as Protocol from "@openclaw/gateway-protocol";

        type Equal<Left, Right> =
          (<Value>() => Value extends Left ? 1 : 2) extends
          (<Value>() => Value extends Right ? 1 : 2) ? true : false;
        type Assert<Condition extends true> = Condition;

        type AgentCreateIsCanonical = Assert<Equal<AgentsCreateParams, Protocol.AgentsCreateParams>>;
        type AgentDeleteIsCanonical = Assert<Equal<AgentsDeleteParams, Protocol.AgentsDeleteParams>>;
        type AgentUpdateIsCanonical = Assert<Equal<AgentsUpdateParams, Protocol.AgentsUpdateParams>>;
        type GatewayArtifactIsCanonical = Assert<Equal<GatewayArtifactSummary, Protocol.ArtifactSummary>>;
        type ToolsEffectiveIsCanonical = Assert<Equal<ToolsEffectiveParams, Protocol.ToolsEffectiveParams>>;
        type WorkerMetadataIsCanonical = Assert<Equal<WorkerEnvironmentMetadata, Protocol.WorkerEnvironmentMetadata>>;
        type WorkerStateIsCanonical = Assert<Equal<WorkerEnvironmentState, Protocol.WorkerEnvironmentState>>;
        type TunnelStatusIsCanonical = Assert<Equal<WorkerTunnelStatus, Protocol.WorkerTunnelStatus>>;

        const artifactDownload: ArtifactsDownloadResult = {
          artifact: {
            id: "artifact-old-consumer", type: "file", sessionId: "session-old-consumer",
            createdAt: "2026-08-16T00:00:00Z", expiresAt: "2026-08-17T00:00:00Z",
            download: { mode: "future-delivery-mode" },
          } satisfies ArtifactSummary,
          expiresAt: "2026-08-17T00:00:00Z",
        };
        const environment: EnvironmentSummary = {
          id: "gateway", type: "local", status: "available", trust: "persistent", desktop: true,
          issues: [{
            code: "update-required",
            action: "update-and-reconnect",
            updateCommand: "openclaw update",
            headlessReconnectCommand: "openclaw node restart",
          }],
          worker: {
            providerId: "worker-provider", state: "ready", ageMs: 1, attachedSessionIds: [],
            tunnelStatus: "connected", desktop: true, desktopApps: ["browser"],
          },
        };
        const environments: EnvironmentsListResult = { environments: [environment] };
        const createSession: SessionCreateParams = { attachments: [{ kind: "custom" }] };
        const sendSession: SessionSendParams = {
          key: "agent:main:external", message: "hello", attachments: [{ kind: "custom" }],
        };
        const toolParams: ToolInvokeParams = {
          sessionKey: "agent:main:external", args: { query: "status" },
        };
        const toolResult: ToolInvokeResult = {
          ok: false, toolName: "status", error: { message: "unavailable" },
        };

        void [artifactDownload, environments, createSession, sendSession, toolParams, toolResult];
      `);
    await consumer.run(`
        import assert from "node:assert/strict";
        import { GatewayClientTransport, OpenClaw, normalizeGatewayEvent } from "@openclaw/sdk";

        assert.equal(typeof GatewayClientTransport, "function");
        const event = normalizeGatewayEvent({
          event: "agent",
          payload: { runId: "packed-run", stream: "lifecycle", data: { phase: "start" } }
        });
        assert.equal(event.type, "run.started");

        let closed = false;
        const client = new OpenClaw({ transport: {
          async request(method, params, options) {
            assert.equal(method, "agent.wait");
            assert.deepEqual(params, { runId: "packed-run", timeoutMs: 25 });
            assert.deepEqual(options, { timeoutMs: null });
            return { status: "ok", runId: "packed-run", sessionKey: "agent:main:external" };
          },
          async *events() {},
          async close() { closed = true; },
        } });

        const run = await client.runs.wait("packed-run", { timeoutMs: 25 });
        await client.close();
        assert.equal(run.status, "completed");
        assert.equal(closed, true);
      `);
  } finally {
    await consumer.cleanup();
  }
}, 240_000);
