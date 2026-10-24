import { mattermostPlugin } from "@openclaw/mattermost/channel-plugin-api.js";
import { setMattermostRuntime } from "@openclaw/mattermost/runtime-api.js";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  type CrablineTransport,
  postJson,
  requireString,
  withTransport,
} from "./crabline-transport.test-support.js";
import { startAgentRun } from "./suite-runtime-agent-process.js";

function waitForReply(
  transport: CrablineTransport,
  conversation: Parameters<CrablineTransport["waitForOutbound"]>[0]["conversation"],
  threadId: string,
  textIncludes: string,
  timeoutMs = 1_000,
) {
  return transport.waitForOutbound({ conversation, threadId, textIncludes, timeoutMs });
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
        await postJson(
          `${matrixBaseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${transactionId}`,
          body,
          "qa-lab-crabline-matrix-thread-correlation-test",
          { method: "PUT", headers: { authorization: `Bearer ${accessToken}` } },
        );

      const wait = (thread: string, text: string, timeout: number) =>
        waitForReply(transport, { id: conversationId, kind: "direct" }, thread, text, timeout);

      await send("qa-root-send", { body: "matrix root reply", msgtype: "m.text" });
      await expect(wait(threadId, "matrix root reply", 50)).rejects.toThrow();
      await expect(wait(secondThreadId, "matrix root reply", 50)).rejects.toThrow();
      await send("qa-thread-send", {
        body: "matrix threaded reply",
        msgtype: "m.text",
        "m.relates_to": { rel_type: "m.thread", event_id: threadId },
      });
      await expect(wait(threadId, "matrix threaded reply", 1_000)).resolves.toMatchObject({
        threadId,
        text: "matrix threaded reply",
      });
      await expect(wait(secondThreadId, "matrix threaded reply", 50)).rejects.toThrow();
      await send("qa-second-thread-send", {
        body: "matrix second threaded reply",
        msgtype: "m.text",
        "m.relates_to": { rel_type: "m.thread", event_id: secondThreadId },
      });
      await expect(
        wait(secondThreadId, "matrix second threaded reply", 1_000),
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
        await postJson<{ id: string }>(
          `${mattermostUrl}/api/v4/posts`,
          { channel_id: channelId, message, ...(rootId ? { root_id: rootId } : {}) },
          "qa-lab-crabline-mattermost-thread-correlation-test",
          { headers: { authorization: `Bearer ${botToken}` } },
        );

      const root = await send("mattermost seed root");
      const conversation = { id: conversationId, kind: "group" } as const;
      transport.buildAgentDelivery({ target: `group:${conversationId}`, threadId: root.id });
      await send("mattermost unrelated root");
      await expect(
        waitForReply(transport, conversation, root.id, "mattermost unrelated root", 50),
      ).rejects.toThrow();
      await send("mattermost threaded reply", root.id);
      await expect(
        waitForReply(transport, conversation, root.id, "mattermost threaded reply"),
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
        waitForReply(
          transport,
          { id: conversationId, kind: "group" },
          threadId,
          "mattermost symbolic threaded reply",
        ),
      ).resolves.toMatchObject({ threadId, text: "mattermost symbolic threaded reply" });
    });
  });
});
