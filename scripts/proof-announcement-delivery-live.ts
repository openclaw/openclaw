import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
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
const origin = { channel: "slack", accountId: "default", to: "user:U000000001" };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function gatewayResultFor(targets: string | readonly string[]) {
  const receiptTargets = typeof targets === "string" ? [targets] : targets;
  return {
    status: "ok",
    result: {
      payloads: [{ text: "subagent result" }],
      didSendViaMessagingTool: true,
      messagingToolSentTargets: receiptTargets.map((target) => ({
        tool: "message",
        provider: "slack",
        accountId: "default",
        to: target,
        sourceReplyFinal: true,
      })),
    },
  };
}

let currentGatewayResult = gatewayResultFor("D000000001");
let fallbackSendCount = 0;

function installProofRuntime() {
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
    sendMessage: async () => {
      fallbackSendCount += 1;
      return {
        channel: "slack",
        to: "user:U000000001",
        via: "direct" as const,
        mediaUrl: null,
        result: { messageId: "fallback-proof" },
      };
    },
  });
}

type HttpHandler = (request: IncomingMessage, response: ServerResponse) => void;

async function startServer(handler: HttpHandler) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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

async function announce(announceOrigin = origin, directIdempotencyKey = "proof:144947") {
  return await sendSubagentAnnounceDirectly({
    requesterSessionKey: "agent:main:main",
    targetRequesterSessionKey: "agent:main:main",
    triggerMessage: "subagent result",
    expectsCompletionMessage: true,
    requireVisibleReply: true,
    bestEffortDeliver: true,
    directIdempotencyKey,
    directOrigin: announceOrigin,
    requesterIsSubagent: false,
    sourceSessionKey: "agent:main:subagent:child",
    sourceTool: "subagent_announce",
    isSourceSessionEffectsAllowed: () => true,
    isCompletionOwnedByRequesterYield: () => false,
  });
}

async function runMatchingAndNegativeControl() {
  let matchingRequests = 0;
  const matchingServer = await startServer((_request, response) => {
    matchingRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ ok: true, channel: { id: "D000000001", is_im: true, user: "U000000001" } }),
    );
  });
  process.env.SLACK_API_URL = matchingServer.baseUrl;
  try {
    const matching = await announce(origin, "proof:144947:success");
    assert(matching.delivered, "matching receipt was not delivered");
    assert(matchingRequests === 1, "matching control did not make exactly one lookup");
    console.log(
      `matching-receipt: delivered=${matching.delivered} path=${matching.path} slackLookupRequests=${matchingRequests}`,
    );
  } finally {
    await matchingServer.close();
  }

  let wrongRecipientRequests = 0;
  const wrongRecipientServer = await startServer((_request, response) => {
    wrongRecipientRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ ok: true, channel: { id: "D000000002", is_im: true, user: "U000000002" } }),
    );
  });
  process.env.SLACK_API_URL = wrongRecipientServer.baseUrl;
  currentGatewayResult = gatewayResultFor("D000000002");
  try {
    const wrongRecipient = await announce(
      { ...origin, to: "user:U000000001" },
      "proof:144947:wrong-recipient",
    );
    assert(!wrongRecipient.delivered, "wrong recipient was incorrectly credited");
    assert(wrongRecipientRequests === 1, "wrong-recipient control did not make exactly one lookup");
    console.log(
      `wrong-recipient: delivered=${wrongRecipient.delivered} reason=${wrongRecipient.reason ?? "none"} slackLookupRequests=${wrongRecipientRequests}`,
    );
  } finally {
    await wrongRecipientServer.close();
  }
}

async function runMixedLookupCase(
  label: string,
  targets: readonly [string, string],
  matchingTarget: string,
  stalledTarget: string,
) {
  let lookupRequests = 0;
  let matchingLookupCompleted = false;
  let stalledLookupStarted = false;
  let stalledLookupCancelled = false;
  const mixedServer = await startServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      lookupRequests += 1;
      const requestText = `${request.url ?? ""} ${Buffer.concat(chunks).toString()}`;
      if (requestText.includes(matchingTarget)) {
        setTimeout(() => {
          matchingLookupCompleted = true;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              ok: true,
              channel: { id: matchingTarget, is_im: true, user: "U000000001" },
            }),
          );
        }, 25);
        return;
      }
      if (requestText.includes(stalledTarget)) {
        stalledLookupStarted = true;
        request.on("close", () => {
          stalledLookupCancelled = true;
        });
        return;
      }
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
    });
  });
  process.env.SLACK_API_URL = mixedServer.baseUrl;
  currentGatewayResult = gatewayResultFor(targets);
  const fallbackBefore = fallbackSendCount;
  try {
    const mixed = await announce(origin, `proof:144947:mixed:${label}`);
    await waitFor(() => stalledLookupCancelled, `${label} stalled lookup cancellation`);
    assert(mixed.delivered, `${label} mixed lookup was not delivered`);
    assert(lookupRequests === 2, `${label} did not make two native lookups`);
    assert(matchingLookupCompleted, `${label} matching lookup did not complete`);
    assert(stalledLookupStarted, `${label} stalled lookup did not start`);
    assert(fallbackSendCount === fallbackBefore, `${label} used the fallback sender`);
    console.log(
      `mixed-${label}: delivered=${mixed.delivered} path=${mixed.path} lookupRequests=${lookupRequests} matchingLookupCompleted=${matchingLookupCompleted} stalledLookupStarted=${stalledLookupStarted} stalledLookupCancelled=${stalledLookupCancelled} fallbackSendCount=${fallbackSendCount - fallbackBefore}`,
    );
  } finally {
    await mixedServer.close();
  }
}

async function runCallerCancellation() {
  let cancelRequestStarted = false;
  let cancelRequestClosed = false;
  const stalledServer = await startServer((request) => {
    cancelRequestStarted = true;
    request.on("close", () => {
      cancelRequestClosed = true;
    });
    request.resume();
  });
  process.env.SLACK_API_URL = stalledServer.baseUrl;
  currentGatewayResult = gatewayResultFor("D000000003");
  const controller = new AbortController();
  const cancellationOrigin = { ...origin, to: "user:U000000003" };
  const startedAt = Date.now();
  const pending = sendSubagentAnnounceDirectly({
    requesterSessionKey: "agent:main:main",
    targetRequesterSessionKey: "agent:main:main",
    triggerMessage: "subagent result",
    expectsCompletionMessage: false,
    requireVisibleReply: true,
    bestEffortDeliver: true,
    directIdempotencyKey: "proof:144947:cancel",
    directOrigin: cancellationOrigin,
    requesterIsSubagent: false,
    sourceSessionKey: "agent:main:subagent:child",
    sourceTool: "subagent_announce",
    signal: controller.signal,
    isSourceSessionEffectsAllowed: () => true,
    isCompletionOwnedByRequesterYield: () => false,
  });
  try {
    await waitFor(() => cancelRequestStarted, "caller cancellation request");
    controller.abort(new Error("proof cancellation"));
    const cancelled = await pending;
    await waitFor(() => cancelRequestClosed, "caller cancellation socket close");
    assert(!cancelled.delivered, "caller cancellation was incorrectly delivered");
    const elapsedMs = Date.now() - startedAt;
    assert(elapsedMs < 500, `caller cancellation took too long: ${elapsedMs}ms`);
    console.log(
      `cancelled-lookup: requestStarted=${cancelRequestStarted} requestClosed=${cancelRequestClosed} returned=true delivered=${cancelled.delivered} elapsedMs=${elapsedMs}`,
    );
  } finally {
    await stalledServer.close();
  }
}

async function main() {
  installProofRuntime();
  await runMatchingAndNegativeControl();
  await runMixedLookupCase(
    "source-first",
    ["D000000004", "D000000005"],
    "D000000004",
    "D000000005",
  );
  await runMixedLookupCase(
    "source-second",
    ["D000000007", "D000000006"],
    "D000000006",
    "D000000007",
  );
  await runCallerCancellation();
}

try {
  await main();
} finally {
  setSubagentAnnounceDeliveryDepsForTest();
}
