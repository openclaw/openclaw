import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { slackPlugin } from "../extensions/slack/src/channel.ts";
import { setSubagentAnnounceDeliveryDepsForTest } from "../src/agents/subagents/announce/subagent-announce-delivery.runtime.ts";
import { sendSubagentAnnounceDirectly } from "../src/agents/subagents/announce/subagent-announce-direct-delivery.ts";
import type { OpenClawConfig } from "../src/config/types.openclaw.ts";
import { setActivePluginRegistry } from "../src/plugins/runtime.ts";
import { createTestRegistry } from "../src/test-utils/channel-plugins.ts";

const cfg = {
  agents: { defaults: { subagents: { announceTimeoutMs: 2_000 } } },
  channels: { slack: { botToken: "loopback-token" } },
  session: { dmScope: "main" },
} as OpenClawConfig;
const sourceOrigin = { channel: "slack", accountId: "default", to: "user:U000000001" };

function gatewayResultFor(target: string) {
  return {
    status: "ok",
    result: {
      payloads: [{ text: "subagent result" }],
      didSendViaMessagingTool: true,
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "slack",
          accountId: "default",
          to: target,
          sourceReplyFinal: true,
        },
      ],
    },
  };
}

let currentGatewayResult = gatewayResultFor("D000000001");

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
  dispatchGatewayMethodInProcess: async <T>() => currentGatewayResult as T,
});

async function startServer(user: string) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        channel: { id: user === "U000000001" ? "D000000001" : "D000000002", is_im: true, user },
      }),
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function announce(
  directOrigin: typeof sourceOrigin = sourceOrigin,
  directIdempotencyKey = "proof:settlement",
) {
  return await sendSubagentAnnounceDirectly({
    requesterSessionKey: "agent:main:main",
    targetRequesterSessionKey: "agent:main:main",
    triggerMessage: "subagent result",
    expectsCompletionMessage: true,
    requireVisibleReply: true,
    bestEffortDeliver: true,
    directIdempotencyKey,
    directOrigin,
    requesterIsSubagent: false,
    sourceSessionKey: "agent:main:subagent:child",
    sourceTool: "subagent_announce",
    isSourceSessionEffectsAllowed: () => true,
    isCompletionOwnedByRequesterYield: () => false,
  });
}

async function main() {
  const matchingServer = await startServer("U000000001");
  process.env.SLACK_API_URL = matchingServer.baseUrl;
  try {
    const matching = await announce(sourceOrigin, "proof:settlement:matching");
    console.log(
      `matching-receipt: delivered=${matching.delivered} reason=${matching.reason ?? "none"}`,
    );
  } finally {
    await matchingServer.close();
  }

  const wrongServer = await startServer("U000000002");
  process.env.SLACK_API_URL = wrongServer.baseUrl;
  currentGatewayResult = gatewayResultFor("D000000002");
  try {
    const wrong = await announce(sourceOrigin, "proof:settlement:wrong-recipient");
    console.log(`wrong-recipient: delivered=${wrong.delivered} reason=${wrong.reason ?? "none"}`);
  } finally {
    await wrongServer.close();
  }
}

try {
  await main();
} finally {
  setSubagentAnnounceDeliveryDepsForTest();
}
