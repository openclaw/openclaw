// Scenario body for the followup-drain proof harness.
//
// This module is loaded through a dynamic import by
// `scripts/proof-w91n-followup-drain-terminal.ts` AFTER that entry has applied
// process isolation. That ordering is load-bearing, not stylistic: production
// modules pin runtime paths at module-evaluation time (`src/config/paths.ts`
// initializes `STATE_DIR`/`CONFIG_PATH` in its module body), so a static import
// of this file from the entry would capture the operator's real paths no matter
// where the isolation statement sat in the entry's import list. `assertIsolated`
// below re-checks the resolved paths rather than trusting the ordering.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { handleDirectiveOnly } from "../src/auto-reply/reply/directive-handling.impl.js";
import { parseInlineSessionDirectives } from "../src/auto-reply/reply/directive-handling.parse.js";
import { createFollowupRunner } from "../src/auto-reply/reply/followup-runner.js";
import type { FollowupRun, QueueSettings } from "../src/auto-reply/reply/queue.js";
import {
  clearSessionQueues,
  enqueueFollowupRun,
  FollowupRunDeferredError,
  scheduleFollowupDrain,
} from "../src/auto-reply/reply/queue.js";
import { FOLLOWUP_QUEUES } from "../src/auto-reply/reply/queue/state.js";
import { CONFIG_PATH, STATE_DIR } from "../src/config/paths.js";
import {
  ensureSessionEntrySync,
  loadSessionEntry,
} from "../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import {
  beginGatewayRestartSignalAdmission,
  GatewayDrainingError,
  resetGatewayWorkAdmission,
} from "../src/process/gateway-work-admission.js";
import { defaultRuntime } from "../src/runtime.js";
import {
  proofHomeDir,
  scrubbedCredentialEnvNames,
} from "./proof-w91n-followup-drain-terminal.isolation.js";

const SETTINGS: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
const AUTHORITY_ERROR = "Reply operation cannot change tool authority after admission";

/** Shipped policy in src/auto-reply/reply/queue/drain.ts. Kept in sync by assertion. */
const EXPECTED_MAX_CONSECUTIVE_FAILURES = 7;
const EXPECTED_BACKOFF_LADDER_MS = [500, 1000, 2000, 4000, 8000, 10_000];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

function createRun(prompt: string, messageId: string): FollowupRun {
  return {
    prompt,
    messageId,
    enqueuedAt: Date.now(),
    originatingChannel: "slack",
    originatingTo: "proof-channel",
    run: {
      agentId: "agent",
      agentDir: "/tmp",
      sessionId: "sess",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp",
      config: {} as OpenClawConfig,
      provider: "openai",
      model: "gpt-test",
      timeoutMs: 10_000,
      blockReplyBreak: "text_end",
    },
  };
}

const capturedErrors: string[] = [];
const realRuntimeError = defaultRuntime.error;
defaultRuntime.error = ((message: unknown) => {
  capturedErrors.push(String(message));
}) as typeof defaultRuntime.error;

function restoreRuntimeError(): void {
  defaultRuntime.error = realRuntimeError;
}

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function waitFor(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`ASSERTION FAILED: timed out after ${timeoutMs}ms waiting for ${label}`);
}

async function scenarioBoundedSuspension(): Promise<void> {
  const key = `proof-w91n-terminal-${Date.now()}`;
  capturedErrors.length = 0;
  let attempts = 0;
  const attemptTimestamps: number[] = [];
  const runFollowup = async (): Promise<void> => {
    attempts += 1;
    attemptTimestamps.push(Date.now());
    throw new Error(AUTHORITY_ERROR);
  };

  const expectedLadderMs = EXPECTED_BACKOFF_LADDER_MS.reduce((sum, ms) => sum + ms, 0);
  console.log(
    `[1/4] wedged item: expecting ${EXPECTED_MAX_CONSECUTIVE_FAILURES} attempts over ~${Math.round(expectedLadderMs / 1000)}s of production backoff...`,
  );
  const startedAt = Date.now();
  enqueueFollowupRun(key, createRun("wedged", "proof-m1"), SETTINGS);
  scheduleFollowupDrain(key, runFollowup);

  await waitFor(
    () => FOLLOWUP_QUEUES.get(key)?.drainSuspended === true,
    "the wedged queue to be suspended",
    expectedLadderMs + 30_000,
  );
  const elapsedMs = Date.now() - startedAt;
  const attemptsAtSuspension = attempts;
  // The loop must be dead, not merely slow: a further settle window adds nothing.
  await sleep(2_000);

  assert(
    attemptsAtSuspension === EXPECTED_MAX_CONSECUTIVE_FAILURES,
    `expected exactly ${EXPECTED_MAX_CONSECUTIVE_FAILURES} attempts before suspension, saw ${attemptsAtSuspension}`,
  );
  assert(
    attempts === attemptsAtSuspension,
    `expected the drain loop to stop after suspension, saw ${attempts - attemptsAtSuspension} extra attempts`,
  );
  assert(
    FOLLOWUP_QUEUES.get(key)?.items[0]?.messageId === "proof-m1",
    "expected the failed input to remain queued without lifecycle settlement",
  );

  const gaps = attemptTimestamps
    .slice(1)
    .map((timestamp, index) => timestamp - (attemptTimestamps[index] ?? timestamp));
  assert(
    gaps.length === EXPECTED_BACKOFF_LADDER_MS.length,
    `expected ${EXPECTED_BACKOFF_LADDER_MS.length} inter-attempt gaps, saw ${gaps.length}`,
  );
  for (const [index, gap] of gaps.entries()) {
    const expected = EXPECTED_BACKOFF_LADDER_MS[index] ?? 0;
    assert(
      gap >= expected * 0.8,
      `expected retry ${index + 1} to wait at least ${expected}ms of backoff, waited ${gap}ms — the storm is not bounded`,
    );
  }

  const suspension = capturedErrors.filter((message) =>
    message.includes("followup queue suspended"),
  );
  assert(
    suspension.length === 1,
    `expected exactly one suspension error, saw ${suspension.length}`,
  );
  const [suspensionMessage] = suspension;
  assert(suspensionMessage?.includes(key) === true, "suspension error must name the session key");
  assert(
    suspensionMessage.includes("messageId=proof-m1"),
    "suspension error must identify the retained item",
  );
  assert(
    suspensionMessage.includes(AUTHORITY_ERROR),
    "suspension error must carry the final underlying error",
  );
  console.log(
    `      ok: ${attempts} attempts, gaps ${gaps.join("/")}ms, suspended after ${(elapsedMs / 1000).toFixed(1)}s`,
  );
  console.log(`      suspension log: ${suspensionMessage}`);
}

async function scenarioDeferredStillRetries(): Promise<void> {
  const key = `proof-w91n-deferred-${Date.now()}`;
  capturedErrors.length = 0;
  const deferrals = EXPECTED_MAX_CONSECUTIVE_FAILURES + 3;
  let attempts = 0;
  let delivered = false;
  const runFollowup = async (): Promise<void> => {
    attempts += 1;
    if (attempts <= deferrals) {
      throw new FollowupRunDeferredError("proof: agent still busy");
    }
    delivered = true;
  };

  console.log(
    `[2/4] deferred item: expecting ${deferrals} deferrals (past the ${EXPECTED_MAX_CONSECUTIVE_FAILURES}-failure cap) then delivery...`,
  );
  enqueueFollowupRun(key, createRun("deferred", "proof-m2"), SETTINGS);
  scheduleFollowupDrain(key, runFollowup);

  await waitFor(() => delivered, "the deferred item to be delivered", 30_000);
  assert(
    attempts === deferrals + 1,
    `expected ${deferrals + 1} attempts, saw ${attempts} — deferred retries must stay unbounded`,
  );
  assert(
    !capturedErrors.some((message) => message.includes("followup queue suspended")),
    "a deferred item must never be suspended",
  );
  console.log(`      ok: ${attempts} attempts, delivered, nothing suspended`);
}

async function scenarioRestartFenceParks(): Promise<void> {
  const key = `proof-w91n-fence-${Date.now()}`;
  capturedErrors.length = 0;
  resetGatewayWorkAdmission();
  let attempts = 0;
  let delivered = false;
  let fenceLease: { rollback: () => boolean } | null = null;
  const runFollowup = async (): Promise<void> => {
    attempts += 1;
    if (attempts === 1) {
      fenceLease = beginGatewayRestartSignalAdmission();
      assert(fenceLease !== null, "expected to raise a reversible restart-signal fence");
      throw new GatewayDrainingError("proof: gateway restart signalled");
    }
    delivered = true;
  };

  console.log(
    "[3/4] restart fence: expecting the drain to park until rollback, without suspension...",
  );
  enqueueFollowupRun(key, createRun("fenced", "proof-m3"), SETTINGS);
  scheduleFollowupDrain(key, runFollowup);

  await waitFor(() => attempts === 1, "the first fenced attempt", 10_000);
  await sleep(3_000);
  const attemptsWhileParked = attempts;
  assert(
    attemptsWhileParked === 1,
    `expected the drain to park on the fence, saw ${attemptsWhileParked} attempts`,
  );
  assert(FOLLOWUP_QUEUES.has(key), "expected the fenced item to stay queued");
  assert(
    !capturedErrors.some((message) => message.includes("followup queue suspended")),
    "a fenced item must never be suspended",
  );

  const lease = fenceLease as { rollback: () => boolean } | null;
  assert(lease !== null, "expected a fence lease to roll back");
  assert(lease.rollback(), "expected the restart-signal fence to roll back");
  await waitFor(() => delivered, "the fenced item to drain after rollback", 30_000);
  assert(attempts === 2, `expected 2 attempts after rollback, saw ${attempts}`);
  console.log("      ok: parked on the fence, then delivered after rollback");
}

const PROOF_CHANNEL = "proofchan";
const RETAINED_MARKER = "PROOF-ITEM-retained";
const SUCCESSOR_MARKER = "PROOF-ITEM-successor";

type DeliveredReply = { to: string; text: string };

/**
 * Starts the loopback provider endpoint. It is an ordinary OpenAI-completions
 * server on 127.0.0.1: the production model client builds and sends the real
 * request, and the reply text echoes whichever proof marker the prompt carried
 * so the two queued items can be told apart at the delivery edge.
 */
async function startLoopbackModelEndpoint(): Promise<{
  baseUrl: string;
  requests: number;
  close: () => Promise<void>;
}> {
  const state = { requests: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      state.requests += 1;
      const marker = body.includes(SUCCESSOR_MARKER)
        ? SUCCESSOR_MARKER
        : body.includes(RETAINED_MARKER)
          ? RETAINED_MARKER
          : "PROOF-ITEM-unknown";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "cmpl-proof-w91n",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1_000),
          model: "proof-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `answered ${marker}` },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  assert(port > 0, "expected the loopback model endpoint to bind a port");
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    get requests() {
      return state.requests;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * Publishes the outbound channel whose `sendText` is the measured final effect.
 * Everything up to this call is production code; this adapter is the transport
 * edge, exactly where a real deployment would hand bytes to a platform SDK.
 */
function registerProofDeliveryChannel(delivered: DeliveredReply[]): void {
  const plugin = {
    id: PROOF_CHANNEL,
    meta: {
      id: PROOF_CHANNEL,
      label: PROOF_CHANNEL,
      selectionLabel: PROOF_CHANNEL,
      docsPath: `/channels/${PROOF_CHANNEL}`,
      blurb: "proof delivery edge",
    },
    capabilities: { chatTypes: ["direct"] },
    config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
    outbound: {
      deliveryMode: "direct",
      sendText: async (payload: { to?: string; text?: string }) => {
        delivered.push({ to: String(payload?.to ?? ""), text: String(payload?.text ?? "") });
        return { channel: PROOF_CHANNEL, messageId: `proof-${delivered.length}` };
      },
      sendMedia: async () => ({ channel: PROOF_CHANNEL, messageId: "proof-media" }),
    },
  };
  const registry = createEmptyPluginRegistry();
  const registration = { pluginId: "proof-w91n", plugin, source: "proof-w91n" };
  registry.channels.push(registration as unknown as (typeof registry.channels)[number]);
  registry.channelSetups.push({
    ...registration,
    enabled: true,
  } as unknown as (typeof registry.channelSetups)[number]);
  setActivePluginRegistry(registry);
}

async function scenarioAcceptedCommandRecovery(): Promise<void> {
  const key = `proof-w91n-recovery-${Date.now()}`;
  capturedErrors.length = 0;
  const delivered: DeliveredReply[] = [];
  registerProofDeliveryChannel(delivered);
  // Delivery happens through the channel callback, so read the count through a
  // call: `asserts` narrowing on `delivered.length` would otherwise pin it to 0.
  const deliveredCount = (): number => delivered.length;
  const endpoint = await startLoopbackModelEndpoint();
  const workspaceDir = path.join(proofHomeDir, "workspace");
  const storePath = path.join(proofHomeDir, "sessions.json");
  fs.mkdirSync(workspaceDir, { recursive: true });

  const cfg = {
    agents: { entries: { agent: { workspace: workspaceDir } } },
    messages: { queue: { mode: "followup", debounceMsByChannel: { [PROOF_CHANNEL]: 0 } } },
    models: {
      providers: {
        proofprovider: {
          api: "openai-completions",
          baseUrl: endpoint.baseUrl,
          apiKey: "proof-local-only",
          models: [
            {
              id: "proof-model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0 },
              maxTokens: 256,
              contextWindow: 8_192,
            },
          ],
        },
      },
    },
  } as unknown as OpenClawConfig;

  // Seed the session through the real store API so the recovery command later
  // commits against a genuine persisted row rather than an invented snapshot.
  ensureSessionEntrySync({ storePath, sessionKey: key }, {
    sessionId: "proof-w91n-session",
    updatedAt: Date.now(),
    queueMode: "followup",
    queueCap: 50,
  } as never);
  const persistedEntry = loadSessionEntry({ storePath, sessionKey: key });
  assert(persistedEntry !== undefined, "expected the proof session to persist to the store");
  const sessionEntry = { ...persistedEntry };
  const sessionStore: Record<string, typeof sessionEntry> = { [key]: sessionEntry };

  const typing = {
    onReplyStart: async () => {},
    startTypingLoop: async () => {},
    startTypingOnText: async () => {},
    refreshTypingTtl: () => {},
    isActive: () => false,
    markRunComplete: () => {},
    markDispatchIdle: () => {},
    cleanup: () => {},
  };
  // The production queue callback. Nothing about it is proof-specific. It runs
  // with the in-memory session owner (`storePath` is optional on this contract);
  // the recovery command below still commits through the real on-disk store,
  // which is the persistence the review asked about.
  const productionRunFollowup = createFollowupRunner({
    typing: typing as never,
    typingMode: "off" as never,
    defaultModel: "proofprovider/proof-model",
    sessionKey: key,
    sessionEntry: sessionEntry as never,
    sessionStore: sessionStore as never,
  });

  // The injected fault stands in for whatever unclassified defect wedged the
  // queue; only suspension depends on it, and scenario 1 already measured that
  // with the shipped backoff ladder. Every attempt after the operator clears it
  // runs the production callback above, unwrapped.
  let faultActive = true;
  let failedAttempts = 0;
  let productionAttempts = 0;
  const runFollowup = async (run: FollowupRun): Promise<void> => {
    if (faultActive) {
      failedAttempts += 1;
      throw new Error(AUTHORITY_ERROR);
    }
    productionAttempts += 1;
    console.log(`      production callback entered for ${run.messageId}`);
    await productionRunFollowup(run);
  };

  const createProofRun = (marker: string, messageId: string): FollowupRun => {
    const run = createRun(`${marker}: please answer.`, messageId);
    run.originatingChannel = PROOF_CHANNEL as FollowupRun["originatingChannel"];
    run.originatingTo = "proof-operator";
    run.disableTools = true;
    run.run = {
      ...run.run,
      agentId: "agent",
      agentDir: workspaceDir,
      workspaceDir,
      sessionId: sessionEntry.sessionId,
      sessionKey: key,
      sessionFile: path.join(workspaceDir, `${messageId}.jsonl`),
      config: cfg,
      provider: "proofprovider",
      model: "proof-model",
      messageProvider: PROOF_CHANNEL,
      timeoutMs: 120_000,
    } as FollowupRun["run"];
    return run;
  };

  resetGatewayWorkAdmission();
  console.log(
    "[4/4] accepted-command recovery: suspending, then recovering through the production reply path...",
  );
  console.log(
    `      isolated home, ${scrubbedCredentialEnvNames.length} provider credential env vars removed; model endpoint ${endpoint.baseUrl}`,
  );
  enqueueFollowupRun(key, createProofRun(RETAINED_MARKER, "proof-retained"), SETTINGS);
  scheduleFollowupDrain(key, runFollowup);

  const ladderMs = EXPECTED_BACKOFF_LADDER_MS.reduce((sum, ms) => sum + ms, 0);
  await waitFor(
    () => FOLLOWUP_QUEUES.get(key)?.drainSuspended === true,
    "the retained queue to be suspended",
    ladderMs + 30_000,
  );
  assert(
    failedAttempts === EXPECTED_MAX_CONSECUTIVE_FAILURES,
    `expected ${EXPECTED_MAX_CONSECUTIVE_FAILURES} failed attempts before suspension, saw ${failedAttempts}`,
  );
  assert(
    deliveredCount() === 0,
    `expected nothing delivered while suspended, saw ${delivered.length}`,
  );

  // The successor arrives while the queue is parked. It must be retained too,
  // and it must not restart draining on its own.
  enqueueFollowupRun(key, createProofRun(SUCCESSOR_MARKER, "proof-successor"), SETTINGS);
  await sleep(2_000);
  assert(
    FOLLOWUP_QUEUES.get(key)
      ?.items.map((item) => item.messageId)
      .join(",") === "proof-retained,proof-successor",
    "expected both the retained item and its successor to stay queued in order",
  );
  assert(
    failedAttempts === EXPECTED_MAX_CONSECUTIVE_FAILURES && deliveredCount() === 0,
    "expected an enqueue during suspension to neither retry nor deliver",
  );
  console.log(
    `      suspended after ${failedAttempts} attempts; retained + successor parked, 0 delivered`,
  );

  // The operator resolves the fault and sends the documented recovery command.
  faultActive = false;
  const storedBefore = loadSessionEntry({ storePath, sessionKey: key });
  const ack = await handleDirectiveOnly({
    cfg,
    agentId: "agent",
    directives: parseInlineSessionDirectives("/queue reset"),
    sessionEntry,
    sessionStore,
    sessionKey: key,
    storePath,
    messageProvider: PROOF_CHANNEL,
    commandAuthorized: true,
    senderIsOwner: false,
    elevatedEnabled: false,
    elevatedAllowed: false,
    defaultProvider: "proofprovider",
    defaultModel: "proof-model",
    aliasIndex: { byAlias: new Map(), byKey: new Map() },
    allowedModelKeys: new Set<string>(),
    allowedModelCatalog: [],
    resetModelOverride: false,
    provider: "proofprovider",
    model: "proof-model",
    initialModelLabel: "proofprovider/proof-model",
    formatModelSwitchEvent: (label: string) => label,
  } as never);
  assert(
    typeof ack?.text === "string" && ack.text.includes("Retained queued messages will retry."),
    `expected the accepted command to acknowledge recovery, saw ${JSON.stringify(ack?.text)}`,
  );
  const storedAfter = loadSessionEntry({ storePath, sessionKey: key });
  assert(
    storedBefore?.queueMode === "followup" && storedAfter?.queueMode === undefined,
    `expected the accepted reset to clear the persisted queue override, saw ${String(storedBefore?.queueMode)} -> ${String(storedAfter?.queueMode)}`,
  );
  assert(
    (storedAfter?.updatedAt ?? 0) > (storedBefore?.updatedAt ?? 0),
    "expected the accepted command to commit a newer persisted revision",
  );
  console.log(`      accepted command: ${ack?.text?.trim()}`);
  console.log(
    `      persisted store committed: queueMode ${String(storedBefore?.queueMode)} -> ${String(storedAfter?.queueMode)}`,
  );

  try {
    await waitFor(
      () => delivered.length >= 2,
      "the retained item and its successor to be delivered",
      120_000,
    );
  } catch (error) {
    const q = FOLLOWUP_QUEUES.get(key);
    console.error(
      "      queue state:",
      JSON.stringify({
        present: Boolean(q),
        draining: q?.draining,
        suspended: q?.drainSuspended,
        retryTimer: Boolean(q?.retryTimer),
        debounceMs: q?.debounceMs,
        mode: q?.mode,
        items: q?.items.map((item) => item.messageId),
        inFlight: q?.inFlight.size,
        productionAttempts,
      }),
    );
    console.error("      captured runtime errors:", JSON.stringify(capturedErrors, null, 2));
    console.error("      loopback requests:", endpoint.requests);
    console.error("      delivered:", JSON.stringify(delivered));
    throw error;
  }
  await sleep(2_000);

  assert(
    delivered.length === 2,
    `expected exactly two production deliveries, saw ${delivered.length}: ${JSON.stringify(delivered)}`,
  );
  const [first, second] = delivered;
  assert(
    first?.text.includes(RETAINED_MARKER) === true,
    `expected the retained item to be delivered first, saw ${JSON.stringify(first)}`,
  );
  assert(
    second?.text.includes(SUCCESSOR_MARKER) === true,
    `expected its successor to be delivered second, saw ${JSON.stringify(second)}`,
  );
  assert(
    first?.to === "proof-operator" && second?.to === "proof-operator",
    "expected both deliveries to route back to the originating conversation",
  );
  assert(
    endpoint.requests >= 2,
    `expected each recovered turn to reach the production model client, saw ${endpoint.requests} requests`,
  );
  assert(
    !FOLLOWUP_QUEUES.has(key),
    "expected the recovered queue to retire once all accepted work was delivered",
  );
  assert(
    capturedErrors.filter((message) => message.includes("followup queue suspended")).length === 1,
    "expected exactly one suspension, and no re-suspension after recovery",
  );
  console.log(
    `      delivered in order: ${delivered.map((entry) => entry.text.trim()).join(" | ")}`,
  );
  await endpoint.close();
}

/**
 * Fails closed when a production module pinned its runtime paths before the
 * entry applied isolation. Checking the resolved values is the only honest
 * assertion here: import order alone is not observable from inside this module.
 */
function assertIsolated(): void {
  for (const [label, value] of [
    ["STATE_DIR", STATE_DIR],
    ["CONFIG_PATH", CONFIG_PATH],
  ] as const) {
    assert(
      path.resolve(value).startsWith(path.resolve(proofHomeDir)),
      `expected the production ${label} to resolve inside the throwaway home ${proofHomeDir}, saw ${value} — a production module pinned its runtime paths before isolation applied`,
    );
  }
  console.log(`      isolation verified: STATE_DIR and CONFIG_PATH resolve under ${proofHomeDir}`);
}

export async function runProofScenarios(): Promise<void> {
  // Unref'd backoff timers must not be the only thing holding the loop open.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    assertIsolated();
    await scenarioBoundedSuspension();
    await scenarioDeferredStillRetries();
    await scenarioRestartFenceParks();
    await scenarioAcceptedCommandRecovery();
  } finally {
    clearInterval(keepAlive);
    clearSessionQueues([...FOLLOWUP_QUEUES.keys()]);
    resetGatewayWorkAdmission();
    restoreRuntimeError();
  }
  console.log("All runtime assertions passed.");
}
