import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { slackPlugin } from "../extensions/slack/src/channel.ts";
import { setSubagentAnnounceDeliveryDepsForTest } from "../src/agents/subagents/announce/subagent-announce-delivery.runtime.ts";
import { sendSubagentAnnounceDirectly } from "../src/agents/subagents/announce/subagent-announce-direct-delivery.ts";
import type { OpenClawConfig } from "../src/config/types.openclaw.ts";
import { setActivePluginRegistry } from "../src/plugins/runtime.ts";
import { createTestRegistry } from "../src/test-utils/channel-plugins.ts";

const cfg = {
  agents: { defaults: { subagents: { announceTimeoutMs: 250 } } },
  channels: { slack: { botToken: "loopback-token" } },
  session: { dmScope: "main" },
} as OpenClawConfig;
const deliveryTarget = { channel: "slack", accountId: "default", to: "user:U000000001" };

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = () => {
      if (predicate()) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(poll, 1);
    };
    poll();
  });
}

async function startServer(state: {
  matchingLookupStarted: boolean;
  matchingLookupCompleted: boolean;
  stalledLookupStarted: boolean;
  stalledLookupSocketClosed: boolean;
}) {
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("end", () => {
      const requestText = `${request.url ?? ""} ${Buffer.concat(chunks).toString()}`;
      if (requestText.includes("D000000010")) {
        state.matchingLookupStarted = true;
        setTimeout(() => {
          state.matchingLookupCompleted = true;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              ok: true,
              channel: { id: "D000000010", is_im: true, user: "U000000001" },
            }),
          );
        }, 25);
        return;
      }
      if (requestText.includes("D000000011")) {
        state.stalledLookupStarted = true;
        response.socket?.once("close", () => {
          state.stalledLookupSocketClosed = true;
        });
      }
    });
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.resume();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/api/`,
  };
}

const state = {
  matchingLookupStarted: false,
  matchingLookupCompleted: false,
  stalledLookupStarted: false,
  stalledLookupSocketClosed: false,
};
let fallbackSendCount = 0;
setActivePluginRegistry(
  createTestRegistry([
    { pluginId: "slack", source: "proof", origin: "bundled", plugin: slackPlugin },
  ]),
);
setSubagentAnnounceDeliveryDepsForTest({
  getRuntimeConfig: () => cfg,
  loadRequesterSessionEntry: () => ({
    cfg,
    entry: { sessionId: "requester-session", updatedAt: 1 },
    canonicalKey: "agent:main:main",
    agentId: "main",
  }),
  getRequesterSessionActivity: () => ({ isActive: false }),
  resolveRequesterSessionAbandonment: () => undefined,
  dispatchGatewayMethodInProcess: async <T>() =>
    ({
      status: "ok",
      result: {
        payloads: [{ text: "subagent result" }],
        didSendViaMessagingTool: true,
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            accountId: "default",
            to: "D000000010",
            sourceReplyFinal: false,
          },
          {
            tool: "message",
            provider: "slack",
            accountId: "default",
            to: "D000000011",
            sourceReplyFinal: true,
          },
        ],
      },
    }) as T,
  sendMessage: async () => {
    fallbackSendCount += 1;
    return {
      channel: "slack",
      to: deliveryTarget.to,
      via: "direct" as const,
      mediaUrl: null,
      result: { messageId: "fallback-proof" },
    };
  },
});

const { server, baseUrl } = await startServer(state);
process.env.SLACK_API_URL = baseUrl;
try {
  const result = await sendSubagentAnnounceDirectly({
    requesterSessionKey: "agent:main:main",
    targetRequesterSessionKey: "agent:main:main",
    triggerMessage: "subagent result",
    expectsCompletionMessage: true,
    bestEffortDeliver: true,
    directIdempotencyKey: "proof:native-progress-timeout",
    directOrigin: deliveryTarget,
    requesterIsSubagent: false,
    sourceSessionKey: "agent:main:subagent:child",
    sourceTool: "subagent_announce",
    isSourceSessionEffectsAllowed: () => true,
    isCompletionOwnedByRequesterYield: () => false,
  });
  await waitFor(() => state.stalledLookupSocketClosed, 100);
  console.log(
    `native-progress-timeout: delivered=${String(result.delivered)} reason=${result.reason ?? "none"} matchingLookupStarted=${String(state.matchingLookupStarted)} matchingLookupCompleted=${String(state.matchingLookupCompleted)} stalledLookupStarted=${String(state.stalledLookupStarted)} stalledLookupSocketClosed=${String(state.stalledLookupSocketClosed)} fallbackSendCount=${String(fallbackSendCount)}`,
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  setSubagentAnnounceDeliveryDepsForTest();
}
