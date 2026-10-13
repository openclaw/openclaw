import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";
import { slackPlugin } from "../extensions/slack/src/channel.ts";
import { sendSubagentAnnounceDirectly } from "../src/agents/subagents/announce/subagent-announce-direct-delivery.ts";
import { setSubagentAnnounceDeliveryDepsForTest } from "../src/agents/subagents/announce/subagent-announce-overrides.test-support.ts";
import * as sessionEntryReadRuntime from "../src/config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../src/config/sessions/types.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.ts";
import type { dispatchGatewayMethodInProcess } from "../src/gateway/server-plugin-in-process-dispatch.ts";
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
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
  }
}

function gatewayResultFor(
  targets: string | readonly string[],
  sourceReplyFinal: boolean | readonly boolean[] = true,
) {
  const receiptTargets = typeof targets === "string" ? [targets] : targets;
  return {
    status: "ok",
    result: {
      payloads: [{ text: "subagent result" }],
      didSendViaMessagingTool: true,
      messagingToolSentTargets: receiptTargets.map((target, index) => ({
        tool: "message",
        provider: "slack",
        accountId: "default",
        to: target,
        sourceReplyFinal: Array.isArray(sourceReplyFinal)
          ? (sourceReplyFinal[index] ?? true)
          : sourceReplyFinal,
      })),
    },
  };
}

let currentGatewayResult: unknown = gatewayResultFor("D000000001");
let fallbackSendCount = 0;
let sourceEffectsAllowed = true;
let currentRequesterEntry: SessionEntry = {
  sessionId: "requester-session",
  lifecycleRevision: "proof-requester-revision",
  updatedAt: 1,
};
let currentGatewayDispatchGate: { onStart: () => void; wait: Promise<void> } | undefined;
let currentGatewayAcceptedCallback = false;

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
      entry: currentRequesterEntry,
      canonicalKey: "agent:main:main",
      agentId: "main",
      storePath: "/proof/requester/sessions.json",
    }),
    getRequesterSessionActivity: () => ({ isActive: false }),
    resolveRequesterSessionAbandonment: () => undefined,
    dispatchGatewayMethodInProcess: async <T>(
      ...args: Parameters<typeof dispatchGatewayMethodInProcess>
    ) => {
      if (currentGatewayAcceptedCallback) {
        args[2]?.onAccepted?.({ status: "accepted" });
      }
      const gate = currentGatewayDispatchGate;
      if (gate) {
        currentGatewayDispatchGate = undefined;
        gate.onStart();
        await gate.wait;
      }
      return currentGatewayResult as T;
    },
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

type HttpHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

async function startServer(handler: HttpHandler) {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
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
  announceOrigin = origin,
  directIdempotencyKey = "proof:144947",
  requireVisibleReply = true,
  isSourceSessionEffectsAllowed = () => sourceEffectsAllowed,
  sourceTool = "subagent_announce",
) {
  return await sendSubagentAnnounceDirectly({
    requesterSessionKey: "agent:main:main",
    targetRequesterSessionKey: "agent:main:main",
    triggerMessage: "subagent result",
    expectsCompletionMessage: true,
    requireVisibleReply,
    bestEffortDeliver: true,
    directIdempotencyKey,
    directOrigin: announceOrigin,
    requesterIsSubagent: false,
    sourceSessionKey: "agent:main:subagent:child",
    sourceTool,
    isSourceSessionEffectsAllowed,
    isCompletionOwnedByRequesterYield: () => false,
  });
}

async function runRevokedOwnershipDuringLookup() {
  const ownershipOrigin = { ...origin, to: "user:U999999991" };
  const ownershipReceipt = "D999999991";
  let lookupStarted = false;
  let lookupRequests = 0;
  let releaseLookup: (() => void) | undefined;
  const lookupGate = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  const delayedLookupServer = await startServer(async (_request, response) => {
    lookupRequests += 1;
    lookupStarted = true;
    await lookupGate;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        channel: { id: ownershipReceipt, is_im: true, user: "U999999991" },
      }),
    );
  });
  process.env.SLACK_API_URL = delayedLookupServer.baseUrl;
  currentGatewayResult = gatewayResultFor(ownershipReceipt);
  sourceEffectsAllowed = true;
  const fallbackCountBefore = fallbackSendCount;
  const pending = announce(ownershipOrigin, "proof:144947:source-revoked");
  try {
    await waitFor(() => lookupStarted, "source ownership recipient lookup");
    sourceEffectsAllowed = false;
    releaseLookup?.();
    const revoked = await pending;
    assert(!revoked.delivered, "revoked source owner was incorrectly credited as delivered");
    assert(
      revoked.reason === "source_owner_changed",
      `revoked source owner returned unexpected reason: ${revoked.reason ?? "none"}`,
    );
    assert(lookupRequests === 1, `source ownership proof made ${lookupRequests} lookups`);
    assert(
      fallbackSendCount === fallbackCountBefore,
      "source ownership revocation triggered direct fallback",
    );
    console.log(
      `source-owner-revoked-during-lookup: lookupRequests=${lookupRequests} delivered=${String(revoked.delivered)} reason=${revoked.reason} fallbackDelta=${fallbackSendCount - fallbackCountBefore}`,
    );
  } finally {
    sourceEffectsAllowed = true;
    releaseLookup?.();
    await delayedLookupServer.close();
  }
}

async function runLateRecoveryOwnerRevokedDuringLookup() {
  const directIdempotencyKey = "proof:144947:late-recovery-source-revoked";
  const ownershipOrigin = { ...origin, to: "user:U999999992" };
  const ownershipReceipt = "D999999992";
  let lookupStarted = false;
  let lookupRequests = 0;
  let releaseLookup: (() => void) | undefined;
  const lookupGate = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  const delayedLookupServer = await startServer(async (_request, response) => {
    lookupRequests += 1;
    lookupStarted = true;
    await lookupGate;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        channel: { id: ownershipReceipt, is_im: true, user: "U999999992" },
      }),
    );
  });
  const baselineEntry: SessionEntry = {
    sessionId: "requester-session",
    lifecycleRevision: "proof-requester-revision",
    updatedAt: 1,
  };
  let releaseDispatch: (() => void) | undefined;
  let markDispatchStarted: (() => void) | undefined;
  const dispatchGate = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  const dispatchStarted = new Promise<void>((resolve) => {
    markDispatchStarted = resolve;
  });
  let recoveryReads = 0;
  const recoveryRead = vi
    .spyOn(sessionEntryReadRuntime, "readSessionEntriesFromStoreInWorker")
    .mockImplementation(async () => {
      recoveryReads += 1;
      return {
        kind: "session-exact-entries",
        entries: [{ sessionKey: "agent:main:main", entry: currentRequesterEntry }],
        lifecycleTimestamps: {},
      };
    });
  process.env.SLACK_API_URL = delayedLookupServer.baseUrl;
  currentGatewayResult = { status: "accepted" };
  currentRequesterEntry = baselineEntry;
  currentGatewayAcceptedCallback = true;
  currentGatewayDispatchGate = {
    onStart: () => markDispatchStarted?.(),
    wait: dispatchGate,
  };
  sourceEffectsAllowed = true;
  const fallbackCountBefore = fallbackSendCount;
  const pending = announce(
    ownershipOrigin,
    directIdempotencyKey,
    true,
    undefined,
    "subagent_settle",
  );
  try {
    await dispatchStarted;
    currentRequesterEntry = {
      ...baselineEntry,
      restartRecoveryTerminalRunIds: [directIdempotencyKey],
      restartRecoveryTerminalDeliveryEvidence: [
        {
          runId: directIdempotencyKey,
          transcriptRunId: "recovery-successor",
          captured: true,
          payloads: [{ visible: true }],
          messagingToolSentTargets: [
            {
              provider: "slack",
              accountId: "default",
              to: ownershipReceipt,
              sourceReplyFinal: true,
              visible: true,
            },
          ],
        },
      ],
    };
    releaseDispatch?.();
    await Promise.race([
      waitFor(() => lookupStarted, "late recovery recipient lookup"),
      pending.then((result) => {
        throw new Error(
          `Late recovery settled before recipient lookup: ${JSON.stringify({ result, recoveryReads })}`,
        );
      }),
    ]);
    sourceEffectsAllowed = false;
    releaseLookup?.();
    const revoked = await pending;
    assert(!revoked.delivered, "late recovery credited a revoked source owner as delivered");
    assert(
      revoked.reason === "source_owner_changed",
      `late recovery returned unexpected reason: ${revoked.reason ?? "none"}`,
    );
    assert(recoveryReads === 1, `late recovery made ${recoveryReads} session reads`);
    assert(lookupRequests === 1, `late recovery made ${lookupRequests} Slack lookups`);
    assert(
      fallbackSendCount === fallbackCountBefore,
      "late recovery ownership revocation triggered a fallback send",
    );
    console.log(
      `late-recovery-source-owner-revoked-during-lookup: dispatch=accepted recoveryReads=${recoveryReads} slackLookupRequests=${lookupRequests} delivered=${String(revoked.delivered)} reason=${revoked.reason} fallbackDelta=${fallbackSendCount - fallbackCountBefore}`,
    );
  } finally {
    sourceEffectsAllowed = true;
    releaseDispatch?.();
    releaseLookup?.();
    currentGatewayDispatchGate = undefined;
    currentGatewayAcceptedCallback = false;
    currentGatewayResult = gatewayResultFor("D000000001");
    currentRequesterEntry = baselineEntry;
    recoveryRead.mockRestore();
    await delayedLookupServer.close();
  }
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
  matchingSourceReplyFinal = true,
  requireVisibleReply = true,
  minimumLookupRequests = 2,
) {
  let lookupRequests = 0;
  let matchingLookupCompleted = false;
  let stalledLookupStarted = false;
  let stalledLookupSocketOpenBeforeMatch = false;
  let stalledLookupSocketClosed = false;
  let stalledLookupSocket: NonNullable<ServerResponse["socket"]> | undefined;
  const mixedServer = await startServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      lookupRequests += 1;
      const requestText = `${request.url ?? ""} ${Buffer.concat(chunks).toString()}`;
      if (requestText.includes(matchingTarget)) {
        setTimeout(() => {
          stalledLookupSocketOpenBeforeMatch = Boolean(
            stalledLookupSocket && !stalledLookupSocket.destroyed,
          );
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
        const socket = response.socket;
        if (!socket) {
          throw new Error(`${label} stalled lookup has no server socket`);
        }
        stalledLookupSocket = socket;
        socket.once("close", () => {
          stalledLookupSocketClosed = true;
        });
        return;
      }
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
    });
  });
  process.env.SLACK_API_URL = mixedServer.baseUrl;
  currentGatewayResult = gatewayResultFor(targets, [matchingSourceReplyFinal, true]);
  const fallbackBefore = fallbackSendCount;
  try {
    const mixed = await announce(origin, `proof:144947:mixed:${label}`, requireVisibleReply);
    await waitFor(() => stalledLookupSocketClosed, `${label} stalled lookup socket close`);
    assert(mixed.delivered, `${label} mixed lookup was not delivered`);
    assert(
      lookupRequests >= minimumLookupRequests,
      `${label} made too few native lookups: ${lookupRequests}`,
    );
    assert(matchingLookupCompleted, `${label} matching lookup did not complete`);
    assert(stalledLookupStarted, `${label} stalled lookup did not start`);
    assert(stalledLookupSocketOpenBeforeMatch, `${label} socket closed before matching settled`);
    assert(fallbackSendCount === fallbackBefore, `${label} used the fallback sender`);
    console.log(
      `mixed-${label}: delivered=${String(mixed.delivered)} path=${mixed.path} lookupRequests=${String(lookupRequests)} matchingLookupCompleted=${String(matchingLookupCompleted)} stalledLookupStarted=${String(stalledLookupStarted)} stalledLookupSocketOpenBeforeMatch=${String(stalledLookupSocketOpenBeforeMatch)} stalledLookupSocketClosed=${String(stalledLookupSocketClosed)} fallbackSendCount=${String(fallbackSendCount - fallbackBefore)}`,
    );
  } finally {
    await mixedServer.close();
  }
}

async function runCallerCancellation() {
  let cancelRequestStarted = false;
  let cancelRequestSocketOpenBeforeAbort = false;
  let cancelRequestSocketClosed = false;
  const stalledServer = await startServer((request, response) => {
    cancelRequestStarted = true;
    const socket = response.socket;
    if (!socket) {
      throw new Error("caller cancellation has no server socket");
    }
    cancelRequestSocketOpenBeforeAbort = !socket.destroyed;
    socket.once("close", () => {
      cancelRequestSocketClosed = true;
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
    await waitFor(() => cancelRequestSocketClosed, "caller cancellation socket close");
    assert(
      cancelRequestSocketOpenBeforeAbort,
      "caller cancellation socket was not open before abort",
    );
    assert(!cancelled.delivered, "caller cancellation was incorrectly delivered");
    const elapsedMs = Date.now() - startedAt;
    assert(elapsedMs < 500, `caller cancellation took too long: ${elapsedMs}ms`);
    console.log(
      `cancelled-lookup: requestStarted=${String(cancelRequestStarted)} socketOpenBeforeAbort=${String(cancelRequestSocketOpenBeforeAbort)} socketClosed=${String(cancelRequestSocketClosed)} returned=true delivered=${String(cancelled.delivered)} elapsedMs=${String(elapsedMs)}`,
    );
  } finally {
    await stalledServer.close();
  }
}

async function main() {
  installProofRuntime();
  await runMatchingAndNegativeControl();
  await runRevokedOwnershipDuringLookup();
  await runLateRecoveryOwnerRevokedDuringLookup();
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
  await runMixedLookupCase(
    "native-progress-before-stalled-final",
    ["D000000020", "D000000021"],
    "D000000020",
    "D000000021",
    false,
    false,
  );
  await runCallerCancellation();
}

try {
  await main();
} finally {
  setSubagentAnnounceDeliveryDepsForTest();
}
