// Crabline runner tests preserve provider-native thread ownership at the Gateway boundary.
import type { OpenClawCrablineChannelDriverSelection } from "@openclaw/crabline";
import { mattermostPlugin } from "@openclaw/mattermost/channel-plugin-api.js";
import { setMattermostRuntime } from "@openclaw/mattermost/runtime-api.js";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";
import { startAgentRun } from "./suite-runtime-agent-process.js";

function createSelection(channel: OpenClawCrablineChannelDriverSelection["channel"]) {
  return {
    capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
    channel,
    channelDriver: "crabline",
    providerReadinessArtifactPath: "crabline-provider-readiness.json",
  } as const;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} is required`);
  }
  return value;
}

async function postJson<T>(params: {
  url: string;
  body: unknown;
  headers?: Record<string, string>;
  method?: string;
  auditContext: string;
}): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    init: {
      body: JSON.stringify(params.body),
      headers: { "content-type": "application/json", ...params.headers },
      method: params.method ?? "POST",
    },
    policy: { allowPrivateNetwork: true },
    auditContext: params.auditContext,
  });
  try {
    expect(response.ok).toBe(true);
    return (await response.json()) as T;
  } finally {
    await release();
  }
}

describe("Crabline provider thread routing", () => {
  it.each([
    { channel: "matrix", threadId: "$native-thread:matrix.test" },
    { channel: "mattermost", threadId: "threadroot0000000000000000" },
  ] as const)(
    "forwards $channel threads at the Gateway boundary",
    async ({ channel, threadId }) => {
      await withTempDir("qa-crabline-transport-", async (outputDir) => {
        const transport = await createQaCrablineTransportAdapter({
          outputDir,
          selection: createSelection(channel),
          state: createQaBusState(),
        });
        const gatewayCall = vi.fn(async () => ({ runId: `run-${channel}` }));

        try {
          await expect(
            startAgentRun({ gateway: { call: gatewayCall }, transport } as never, {
              sessionKey: `agent:qa:${channel}`,
              message: "thread routing proof",
              to: "group:qa-channel",
              threadId,
            }),
          ).resolves.toEqual({ runId: `run-${channel}` });
          expect(gatewayCall).toHaveBeenCalledWith(
            "agent",
            expect.objectContaining({ channel, threadId }),
            { timeoutMs: 30_000 },
          );
        } finally {
          await transport.cleanupAfterGatewayStop?.();
        }
      });
    },
  );

  it("keeps Matrix root and thread correlation distinct", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("matrix"),
        state: createQaBusState(),
      });
      const conversationId = "matrix:room:!qa:matrix.test";
      const threadId = "$native-thread:matrix.test";
      const secondThreadId = "$second-thread:matrix.test";
      try {
        await transport.state.addInboundMessage({
          conversation: { id: conversationId, kind: "group" },
          senderId: "driver",
          text: "provision Matrix thread room",
        });
        await transport.state.reset();
        const delivery = transport.buildAgentDelivery({
          target: conversationId,
          threadId,
        });
        transport.buildAgentDelivery({ target: conversationId, threadId: secondThreadId });
        const roomId = delivery.to.replace(/^room:/u, "");
        const env = transport.createRuntimeEnvPatch?.() ?? {};
        const matrixBaseUrl = requireString(env.MATRIX_BASE_URL, "Matrix base URL");
        const accessToken = requireString(env.MATRIX_ACCESS_TOKEN, "Matrix access token");
        const send = async (transactionId: string, body: Record<string, unknown>) =>
          await postJson({
            url: `${matrixBaseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${transactionId}`,
            body,
            headers: { authorization: `Bearer ${accessToken}` },
            method: "PUT",
            auditContext: "qa-lab-crabline-matrix-thread-correlation-test",
          });

        await send("qa-root-send", { body: "matrix root reply", msgtype: "m.text" });
        await expect(
          transport.waitForOutbound({
            conversation: { id: conversationId, kind: "direct" },
            threadId,
            textIncludes: "matrix root reply",
            timeoutMs: 50,
          }),
        ).rejects.toThrow();
        await expect(
          transport.waitForOutbound({
            conversation: { id: conversationId, kind: "direct" },
            threadId: secondThreadId,
            textIncludes: "matrix root reply",
            timeoutMs: 50,
          }),
        ).rejects.toThrow();
        await send("qa-thread-send", {
          body: "matrix threaded reply",
          msgtype: "m.text",
          "m.relates_to": { rel_type: "m.thread", event_id: threadId },
        });
        await expect(
          transport.waitForOutbound({
            conversation: { id: conversationId, kind: "direct" },
            threadId,
            textIncludes: "matrix threaded reply",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({ threadId, text: "matrix threaded reply" });
        await expect(
          transport.waitForOutbound({
            conversation: { id: conversationId, kind: "direct" },
            threadId: secondThreadId,
            textIncludes: "matrix threaded reply",
            timeoutMs: 50,
          }),
        ).rejects.toThrow();
        await send("qa-second-thread-send", {
          body: "matrix second threaded reply",
          msgtype: "m.text",
          "m.relates_to": { rel_type: "m.thread", event_id: secondThreadId },
        });
        await expect(
          transport.waitForOutbound({
            conversation: { id: conversationId, kind: "direct" },
            threadId: secondThreadId,
            textIncludes: "matrix second threaded reply",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          threadId: secondThreadId,
          text: "matrix second threaded reply",
        });
      } finally {
        await transport.cleanupAfterGatewayStop?.();
      }
    });
  });

  it("keeps Mattermost root and thread correlation distinct", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("mattermost"),
        state: createQaBusState(),
      });
      const conversationId = "thread-channel";
      try {
        await transport.state.addInboundMessage({
          conversation: { id: conversationId, kind: "group" },
          senderId: "alice",
          text: "provision Mattermost thread channel",
        });
        await transport.state.reset();
        const rootDelivery = transport.buildAgentDelivery({ target: `group:${conversationId}` });
        const channelId = rootDelivery.to.replace(/^channel:/u, "");
        const env = transport.createRuntimeEnvPatch?.() ?? {};
        const mattermostUrl = requireString(env.MATTERMOST_URL, "Mattermost URL");
        const botToken = requireString(env.MATTERMOST_BOT_TOKEN, "Mattermost bot token");
        const send = async (message: string, rootId?: string) =>
          await postJson<{ id: string }>({
            url: `${mattermostUrl}/api/v4/posts`,
            body: { channel_id: channelId, message, ...(rootId ? { root_id: rootId } : {}) },
            headers: { authorization: `Bearer ${botToken}` },
            auditContext: "qa-lab-crabline-mattermost-thread-correlation-test",
          });

        const root = await send("mattermost seed root");
        transport.buildAgentDelivery({ target: `group:${conversationId}`, threadId: root.id });
        await send("mattermost unrelated root");
        await expect(
          transport.waitForOutbound({
            conversation: { id: conversationId, kind: "group" },
            threadId: root.id,
            textIncludes: "mattermost unrelated root",
            timeoutMs: 50,
          }),
        ).rejects.toThrow();
        await send("mattermost threaded reply", root.id);
        await expect(
          transport.waitForOutbound({
            conversation: { id: conversationId, kind: "group" },
            threadId: root.id,
            textIncludes: "mattermost threaded reply",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({ threadId: root.id, text: "mattermost threaded reply" });
      } finally {
        await transport.cleanupAfterGatewayStop?.();
      }
    });
  });

  it("delivers symbolic Mattermost threads through their native provider root", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("mattermost"),
        state: createQaBusState(),
      });
      const conversationId = "symbolic-thread-channel";
      const threadId = "post-root";
      const gatewayCall = vi.fn(async (_method: string, _payload: Record<string, unknown>) => ({
        runId: "run-mattermost-symbolic-thread",
      }));
      try {
        setMattermostRuntime(createPluginRuntimeMock());
        await transport.state.addInboundMessage({
          conversation: { id: conversationId, kind: "group" },
          senderId: "alice",
          text: "mattermost symbolic thread seed",
          threadId,
        });
        await startAgentRun({ gateway: { call: gatewayCall }, transport } as never, {
          sessionKey: "agent:qa:mattermost-symbolic-thread",
          message: "mattermost symbolic threaded reply",
          to: `group:${conversationId}`,
          threadId,
        });
        const gatewayPayload = gatewayCall.mock.calls[0]?.[1];
        expect(gatewayPayload).toMatchObject({
          channel: "mattermost",
          threadId: expect.stringMatching(/^[a-z0-9]{26}$/u),
          to: expect.stringMatching(/^channel:[a-z0-9]{26}$/u),
        });

        await mattermostPlugin.outbound?.sendText?.({
          cfg: transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" }),
          to: String(gatewayPayload?.to),
          threadId: String(gatewayPayload?.threadId),
          text: "mattermost symbolic threaded reply",
        });

        await expect(
          transport.waitForOutbound({
            conversation: { id: conversationId, kind: "group" },
            threadId,
            textIncludes: "mattermost symbolic threaded reply",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({ threadId, text: "mattermost symbolic threaded reply" });
      } finally {
        await transport.cleanupAfterGatewayStop?.();
      }
    });
  });
});
