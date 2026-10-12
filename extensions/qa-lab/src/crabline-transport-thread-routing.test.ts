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

async function withTransport(
  channel: OpenClawCrablineChannelDriverSelection["channel"],
  run: (transport: Awaited<ReturnType<typeof createQaCrablineTransportAdapter>>) => Promise<void>,
) {
  await withTempDir("qa-crabline-transport-", async (outputDir) => {
    const transport = await createQaCrablineTransportAdapter({
      outputDir,
      selection: {
        capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
        channel,
        channelDriver: "crabline",
        providerReadinessArtifactPath: "crabline-provider-readiness.json",
      },
      state: createQaBusState(),
    });
    try {
      await run(transport);
    } finally {
      await transport.cleanupAfterGatewayStop();
    }
  });
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
  it("keeps Matrix root and thread correlation distinct", async () => {
    await withTransport("matrix", async (transport) => {
      const conversationId = "matrix:room:!qa:matrix.test";
      const threadId = "$native-thread:matrix.test";
      const secondThreadId = "$second-thread:matrix.test";
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

      const waitForReply = (expectedThreadId: string, textIncludes: string, timeoutMs: number) =>
        transport.waitForOutbound({
          conversation: { id: conversationId, kind: "direct" },
          threadId: expectedThreadId,
          textIncludes,
          timeoutMs,
        });

      await send("qa-root-send", { body: "matrix root reply", msgtype: "m.text" });
      await expect(waitForReply(threadId, "matrix root reply", 50)).rejects.toThrow();
      await expect(waitForReply(secondThreadId, "matrix root reply", 50)).rejects.toThrow();
      await send("qa-thread-send", {
        body: "matrix threaded reply",
        msgtype: "m.text",
        "m.relates_to": { rel_type: "m.thread", event_id: threadId },
      });
      await expect(waitForReply(threadId, "matrix threaded reply", 1_000)).resolves.toMatchObject({
        threadId,
        text: "matrix threaded reply",
      });
      await expect(waitForReply(secondThreadId, "matrix threaded reply", 50)).rejects.toThrow();
      await send("qa-second-thread-send", {
        body: "matrix second threaded reply",
        msgtype: "m.text",
        "m.relates_to": { rel_type: "m.thread", event_id: secondThreadId },
      });
      await expect(
        waitForReply(secondThreadId, "matrix second threaded reply", 1_000),
      ).resolves.toMatchObject({
        threadId: secondThreadId,
        text: "matrix second threaded reply",
      });
    });
  });

  it("keeps Mattermost root and thread correlation distinct", async () => {
    await withTransport("mattermost", async (transport) => {
      const conversationId = "thread-channel";
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
    });
  });

  it("delivers symbolic Mattermost threads through their native provider root", async () => {
    await withTransport("mattermost", async (transport) => {
      const conversationId = "symbolic-thread-channel";
      const threadId = "post-root";
      const gatewayCall = vi.fn(async (_method: string, _payload: Record<string, unknown>) => ({
        runId: "run-mattermost-symbolic-thread",
      }));
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
    });
  });
});
