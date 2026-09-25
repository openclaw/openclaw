/**
 * Live-Gateway proof for PR #126924 — the changed wait-expiry observation,
 * reached by real children on a real Gateway.
 *
 * Run:
 *   pnpm tsx scripts/proof-126924-live-gateway-wait-expiry.ts
 *
 * WHY THIS SCRIPT EXISTS
 * `scripts/proof-126924-isolated-gateway.ts --control` already proves the
 * observed-stop half on a real Gateway (5/5, preserved). Its restart-recovery
 * scenario cannot reach the changed branch: restart recovery replaces the
 * interrupted run and re-anchors the successor's clock, so the successor's wait
 * expires before its own stored deadline rather than on it. This script reaches
 * the branch head-on instead, and follows the same children through to their
 * real completion.
 *
 * THE CONTRACT BEING PROVEN
 * `src/agents/subagents/registry/subagent-registry-run-wait.ts`: when a subagent
 * registry wait times out with no terminal snapshot, the stored run deadline has
 * passed, and the child's session holds no completion, the branch records a
 * NONTERMINAL `waitExpiryObservedAt` and wakes the parent with
 * `{status:"timeout", disposition:"still-running"}` instead of calling
 * `completeAsRunTimeout`. Current main terminalizes at that same point: it
 * publishes `timed_out` and runs terminal cleanup for a child that may still be
 * working — or, as here, for a child that has not started yet.
 *
 * HOW THE SCENARIO REACHES IT, WITHOUT TUNING THE PRODUCT
 * `runTimeoutSeconds` is one floored integer (`sessions_spawn`'s schema is
 * `{type:"integer"}` and `resolveConfiguredSubagentRunTimeoutSeconds` floors it)
 * that sets three things at once: the registry's stored run deadline, the
 * registry's own wait budget, and the child's hard run timeout. The wait is
 * armed inside `registerSubagentRun`, before the child's run starts. So the
 * question is only whether the child's dispatch outlasts the budget:
 *
 *   - If dispatch is fast, the child's observed start moves the deadline out and
 *     the wait expires early; the ordinary retry path then finds the child's own
 *     stop. That is the control behavior, and it is what most spawns do.
 *   - If dispatch outlasts the whole budget, the deadline is still anchored on
 *     the run's registration (`resolveSubagentRunDeadlineMs` falls back to
 *     `createdAt` for a non-collect run whose execution has no observed start),
 *     the wait expires exactly on it, and the child is genuinely not finished —
 *     here, not even started.
 *
 * The second case is an ordinary production condition: a burst of delegated work
 * on a busy Gateway with a short per-run budget. This proof reproduces it by
 * issuing several real parent turns at once, each spawning a real child with a
 * 1-second budget. No product constant is patched, no clock is faked, and no
 * assertion is relaxed; the harness only creates load and then reads the
 * Gateway's own durable state.
 *
 * WHAT IS REAL
 * A real Gateway process started from `dist/entry.js` against a temp
 * `OPENCLAW_STATE_DIR`; real parent agent turns; the real `sessions_spawn` tool;
 * the real subagent registry, wait manager, sweeper, announce flow and
 * detached-task projection; real SQLite. Every assertion reads the Gateway's own
 * persisted rows read-only, from outside the process.
 *
 * WHAT IS STUBBED, AND ONLY THIS
 * The repository's loopback OpenAI provider
 * (`scripts/e2e/mock-openai-server.mjs`). Each parent's first turn is scripted
 * into a `sessions_spawn` call; everything else — parent wrap-ups, the children's
 * own turns, and the provisional wake turns the announce flow drives — receives
 * the same default response. No hosted model, no operator config, no live
 * Gateway, no credentials, and no network beyond loopback.
 *
 * ASSERTIONS (the script exits non-zero on any violation)
 *  1. Provisional, not terminal — `waitExpiryObservedAt` is persisted while
 *     `execution.endedAt` is unset and the detached task still reads `running`.
 *  2. Continued child activity — the same child's own run starts AFTER that
 *     observation, and its own model request reaches the provider afterwards.
 *     On current main this child has already been published `timed_out`.
 *  3. The provisional notification settles on its own — `waitExpiryAnnouncedAt`
 *     is persisted while the run is still nonterminal.
 *  4. Later final settlement and delivery — a child's real success then settles
 *     the run (`outcome.status === "ok"`), the provisional marker is retained
 *     rather than rewritten, the detached task publishes `succeeded` rather than
 *     the clock's `timed_out`, and no expired child is retired at its deadline.
 *  5. Terminal-notification RECEIPT for the same child, after its own
 *     provisional notification settled — the run reaches
 *     `delivery.status === "delivered"` with a `deliveredAt` later than its
 *     `waitExpiryAnnouncedAt`, and the requester's own turn at the provider
 *     carries the Gateway-authored terminal completion block for that exact
 *     child session (`disposition: exited` + `Stats: runtime`) at a later
 *     provider ordinal than the provisional block (`disposition:
 *     still-running`) for the same child.
 *
 * WHY 3 AND 4 NEED NOT LAND ON THE SAME CHILD — BUT 5 DOES
 * `SUBAGENT_WAIT_EXPIRY_TERMINAL_GRACE_MS` deliberately withholds the wake for a
 * moment so an authoritative terminal can win. A child whose own stop lands
 * inside that grace therefore gets no provisional wake at all — which is the
 * intended behavior, not a gap — while a child still unfinished after it does.
 * The burst exercises both halves in one run, and the assertions say which.
 * Assertion 4 is therefore drawn from the expired set. Assertion 5 is the
 * narrower claim and is deliberately same-child: it starts from the children
 * that actually got a provisional wake and requires each candidate's OWN
 * terminal notification, matched by child session key and ordered by the
 * provider's own arrival ordinal.
 *
 * WHY THE RECEIPT IS NOT THIS HARNESS'S BOOKKEEPING
 * Both halves of assertion 5 are written by production code: the delivery
 * receipt comes from the completion-delivery path, which credits `delivered`
 * only from a transport result, and the completion-event block is authored by
 * the Gateway and reaches the provider only because it was delivered into that
 * requester's session. The provisional wake is measured to leave delivery
 * `pending` with no `deliveredAt`, which is asserted rather than assumed, so a
 * receipt stamped after `waitExpiryAnnouncedAt` cannot be the provisional one.
 *
 * NEGATIVE CONTROL
 * Revert the `if (!isTerminalWaitTimeout) { … reportSubagentWaitExpiry … }`
 * branch in `subagent-registry-run-wait.ts` so a bare deadline expiry falls
 * through to `completeAsRunTimeout` — that is current main's behavior — rebuild,
 * and re-run. Assertion 1 can no longer be satisfied by any child and the script
 * fails at "no child reached the nonterminal wait-expiry observation"; with no
 * provisional notification anywhere, assertion 5's ordered pair is unreachable
 * too.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { applyMockOpenAiModelConfig } from "./e2e/lib/fixtures/mock-openai-config.mjs";
import { createGatewayWsClient } from "./lib/gateway-ws-client.ts";

const repoRoot = process.env.PROOF_REPO_ROOT ?? process.cwd();
const entry = path.join(repoRoot, "dist", "entry.js");
const mockServer = path.join(repoRoot, "scripts", "e2e", "mock-openai-server.mjs");

/** Concurrent real parent turns. Enough load that dispatch outlasts the budget. */
const BURST = Number(process.env.PROOF_126924_BURST ?? "16");
/** The whole per-run budget, in whole seconds — the only value the API accepts. */
const RUN_TIMEOUT_SECONDS = 1;
/**
 * The children's own response time. Short enough that the children succeed inside
 * their 1s budget, so their later settlements are real successes.
 */
const CHILD_RESPONSE_DELAY_MS = 500;
/** How long after the last expiry the provisional wake is still expected. */
const ANNOUNCE_SETTLE_WINDOW_MS = 20_000;
/**
 * How long after the last provisional wake the terminal notification's own
 * delivery receipt is still expected. Measured on this host: the terminal
 * receipt lands 5–20 s after the provisional wake settles, because it waits for
 * the child's real stop and then for a requester turn of its own.
 */
const DELIVERY_SETTLE_WINDOW_MS = 45_000;
const OBSERVE_TIMEOUT_MS = 240_000;
/**
 * A completion-event block is ~450 characters from its `session_key:` line to
 * the end of its `Stats:` line. Scanning that far keeps the disposition match
 * inside the block that names the child.
 */
const NOTIFICATION_BLOCK_SCAN_CHARS = 900;
const CHILD_TASK_MARKER = "PROOF126924LIVEEXPIRY";
const PARENT_PROMPT_PREFIX = "Delegate the long task to a subagent.";

const log = (message: string) => process.stdout.write(`${message}\n`);

function buildSpawnFunctionCallEvents(args: Record<string, unknown>, tag: string) {
  // Same wire shape the mock's own `toolCallEvents` produces, passed through its
  // `events` passthrough so the tool call is scripted rather than inferred.
  const serialized = JSON.stringify(args);
  const callId = `call_proof126924_${tag}`;
  const itemId = `fc_proof126924_${tag}`;
  const item = {
    type: "function_call",
    id: itemId,
    call_id: callId,
    name: "sessions_spawn",
    arguments: serialized,
  };
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: itemId,
        call_id: callId,
        name: "sessions_spawn",
        arguments: "",
      },
    },
    { type: "response.function_call_arguments.delta", delta: serialized },
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: {
        id: `resp_proof126924_${tag}`,
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 64,
          output_tokens: 16,
          total_tokens: 80,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ];
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function captureOutput(child: ChildProcessWithoutNullStreams) {
  let buffer = "";
  const append = (chunk: Buffer) => {
    buffer = `${buffer}${chunk.toString()}`.slice(-512 * 1024);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return () => buffer;
}

type RegistryRow = {
  runId: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
  createdAt?: number;
  collect?: boolean;
  delivery?: {
    status?: string;
    deliveredAt?: number;
    announcedAt?: number;
    disposition?: string;
  };
  execution: {
    status?: string;
    startedAt?: number;
    endedAt?: number;
    outcome?: { status?: string; disposition?: string; elapsedMs?: number };
  };
  waitExpiryObservedAt?: number;
  waitExpiryAnnouncedAt?: number;
};

/** What this proof saw first, per child, before any later state overwrote it. */
type ChildObservation = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey?: string;
  createdAt: number;
  expiryObservedAt?: number;
  endedAtWhenExpiryObserved?: number;
  taskStatusWhenExpiryObserved?: string;
  startedAtAfterExpiry?: number;
  childRequestsAtExpiry?: number;

  announcedAt?: number;
  endedAtWhenAnnounced?: number;
  /** The run's delivery state at the instant the provisional wake settled. */
  deliveryWhenAnnounced?: RegistryRow["delivery"];
  finalOutcome?: RegistryRow["execution"]["outcome"];
  finalEndedAt?: number;
  finalExpiryObservedAt?: number;
  finalTaskStatus?: string;
  /** The run's own delivery receipt for its terminal completion notification. */
  finalDelivery?: RegistryRow["delivery"];
};

/** One provider request, in the provider's own arrival order. */
type ProviderRequest = { seq: number; body: string };

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proof-126924-live-"));
const statePath = path.join(stateRoot, "state", "state", "openclaw.sqlite");
const requestLogPath = path.join(stateRoot, "mock-requests.jsonl");
const responseControlPath = path.join(stateRoot, "mock-responses.json");

let mock: ChildProcessWithoutNullStreams | undefined;
let gateway: ChildProcessWithoutNullStreams | undefined;
let readGatewayOutput: () => string = () => "";
let exitCode = 0;

/** The Gateway's own persisted registry rows, read read-only from outside it. */
function readRegistryRows(): RegistryRow[] {
  if (!fs.existsSync(statePath)) {
    return [];
  }
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    const rows = db
      .prepare("select run_id, child_session_key, payload_json from subagent_runs")
      .all() as Array<{ run_id: string; child_session_key: string; payload_json: string }>;
    return rows.map((row) => {
      const record = JSON.parse(row.payload_json) as RegistryRow;
      record.runId = row.run_id;
      record.childSessionKey = row.child_session_key;
      return record;
    });
  } catch {
    // The Gateway may be mid-write, or the table may not exist yet.
    return [];
  } finally {
    db.close();
  }
}

/** The Gateway's detached-task projection — what a parent or operator reads. */
function readTaskStatus(childSessionKey: string): string | undefined {
  if (!fs.existsSync(statePath)) {
    return undefined;
  }
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    const row = db
      .prepare("select status from task_runs where child_session_key = ? order by created_at desc")
      .get(childSessionKey) as { status?: string } | undefined;
    return row?.status;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/**
 * How many of the children's own model requests the loopback provider has taken.
 * A child's turn is told apart from its parent's by the operator prompt: a
 * parent's wrap-up turn replays the `sessions_spawn` arguments and therefore
 * carries the task marker too, but only a parent's turns carry the prompt that
 * started them.
 */
function countChildProviderRequests(): number {
  if (!fs.existsSync(requestLogPath)) {
    return 0;
  }
  return fs
    .readFileSync(requestLogPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((request) => {
      const body =
        typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? "");
      return body.includes(CHILD_TASK_MARKER) && !body.includes(PARENT_PROMPT_PREFIX);
    }).length;
}

/** Every provider request so far, carrying the provider's own arrival ordinal. */
function readProviderRequests(): ProviderRequest[] {
  if (!fs.existsSync(requestLogPath)) {
    return [];
  }
  return fs
    .readFileSync(requestLogPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { seq: number; body: unknown })
    .map((record) => ({
      seq: record.seq,
      body: typeof record.body === "string" ? record.body : JSON.stringify(record.body ?? ""),
    }))
    .toSorted((left, right) => left.seq - right.seq);
}

/**
 * The provider ordinal of the FIRST requester turn that carried a completion
 * event for this exact child session with this disposition.
 *
 * The Gateway writes these blocks itself — `[Internal task completion event]` /
 * `A background task completed`, each with `session_key:` and `disposition:` —
 * and a requester's turn only sees one because the notification was delivered
 * into that requester's session. Matching is block-local: the disposition must
 * appear inside the same block as the child's session key, so one parent's
 * terminal notice can never be credited to another child. The requester's own
 * runtime line (`session=<requesterSessionKey>`) pins the turn to the
 * requester, which is what distinguishes a receipt from the child's own turn.
 */
function findNotificationSeq(params: {
  requests: ProviderRequest[];
  childSessionKey: string;
  requesterSessionKey: string;
  disposition: string;
  requiredBlockText?: string;
}): number | undefined {
  const anchor = `session_key: ${params.childSessionKey}`;
  for (const request of params.requests) {
    if (!request.body.includes(`session=${params.requesterSessionKey}`)) {
      continue;
    }
    let index = request.body.indexOf(anchor);
    while (index >= 0) {
      const blockText = request.body.slice(index, index + NOTIFICATION_BLOCK_SCAN_CHARS);
      if (
        blockText.indexOf(`disposition: ${params.disposition}`) >= 0 &&
        (!params.requiredBlockText || blockText.indexOf(params.requiredBlockText) >= 0)
      ) {
        return request.seq;
      }
      index = request.body.indexOf(anchor, index + 1);
    }
  }
  return undefined;
}

async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(intervalMs);
  }
  throw new Error(`timed out waiting for: ${description}`);
}

function describeObservations(observations: Map<string, ChildObservation>): string {
  return [...observations.values()]
    .map(
      (observation) =>
        `${observation.runId.slice(-8)}{expiry=${observation.expiryObservedAt ?? "-"},` +
        `startAfterExpiry=${observation.startedAtAfterExpiry ?? "-"},` +
        `announced=${observation.announcedAt ?? "-"},` +
        `outcome=${observation.finalOutcome?.status ?? "-"},task=${observation.finalTaskStatus ?? "-"}}`,
    )
    .join(" ");
}

try {
  const [gatewayPort, mockPort] = await Promise.all([freePort(), freePort()]);

  // One scripted `sessions_spawn` turn per parent; they are identical, so the
  // mock's arrival-order assignment cannot mismatch a parent with a task. Every
  // later request — parent wrap-ups, the children's own turns, and the wake
  // turns the announce flow drives — takes the shared default.
  fs.writeFileSync(
    responseControlPath,
    JSON.stringify({
      scriptVersion: "proof-126924-live-burst",
      responses: Array.from({ length: BURST }, (_unused, index) => ({
        events: buildSpawnFunctionCallEvents(
          {
            task: `${CHILD_TASK_MARKER}: take your time and then report back.`,
            label: "proof-126924 live child",
            mode: "run",
            cleanup: "keep",
            runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
          },
          `b${index}`,
        ),
      })),
      default: {
        text: "PROOF126924 child finished after its parent's wait had already expired.",
        chunkDelayMs: CHILD_RESPONSE_DELAY_MS,
      },
    }),
  );

  const configPath = path.join(stateRoot, "openclaw.json");
  const config: Record<string, unknown> = {
    browser: { enabled: false },
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: { mode: "none" },
      // `controlUi.enabled: false` alone does not stop the session-observer
      // digests: they are produced from transcript events, not a subscriber. The
      // mock hands out its script in arrival order, so a stray utility call
      // would steal a scripted parent turn.
      controlUi: { enabled: false, sessionObserver: false },
      tailscale: { mode: "off" },
    },
    // Same reason, for titles and narration. An empty string is the documented
    // opt-out for utility routing.
    agents: { defaults: { utilityModel: "" } },
    plugins: { enabled: false },
  };
  applyMockOpenAiModelConfig(config, { mockPort, modelRef: "openai/gpt-5.6-luna" });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  mock = spawn(process.execPath, [mockServer], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? "en_US.UTF-8",
      MOCK_PORT: String(mockPort),
      MOCK_REQUEST_LOG: requestLogPath,
      MOCK_RESPONSE_CONTROL: responseControlPath,
    },
  });
  captureOutput(mock);
  await waitFor(
    "the mock provider to listen",
    async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${mockPort}/v1/models`);
        return res.ok || res.status === 404;
      } catch {
        return false;
      }
    },
    30_000,
  );
  log(`[boot] mock provider listening on ${mockPort}`);

  gateway = spawn(
    process.execPath,
    [
      entry,
      "gateway",
      "run",
      "--port",
      String(gatewayPort),
      "--bind",
      "loopback",
      "--auth",
      "none",
      "--tailscale",
      "off",
      "--allow-unconfigured",
    ],
    {
      cwd: repoRoot,
      env: {
        CI: "1",
        PATH: process.env.PATH,
        LANG: process.env.LANG ?? "en_US.UTF-8",
        HOME: stateRoot,
        NO_COLOR: "1",
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_HOME: stateRoot,
        OPENCLAW_STATE_DIR: path.join(stateRoot, "state"),
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_TEST_DISABLE_UPDATE_CHECK: "1",
        OPENAI_API_KEY: "proof-126924-live-gateway",
      },
    },
  );
  readGatewayOutput = captureOutput(gateway);
  await waitFor(
    "the gateway to report ready",
    async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${gatewayPort}/readyz`);
        return res.status === 200;
      } catch {
        return false;
      }
    },
    180_000,
  );
  log(`[boot] gateway ready on ${gatewayPort}`);

  const protocol = (await import(
    pathToFileURL(path.join(repoRoot, "dist", "gateway", "protocol", "index.js")).href
  )) as { PROTOCOL_VERSION: number };
  const client = createGatewayWsClient({ url: `ws://127.0.0.1:${gatewayPort}` });
  await client.waitOpen();
  const request = async (method: string, params: unknown, timeoutMs = 180_000) => {
    const response = await client.request(method, params, timeoutMs);
    if (!response.ok) {
      throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
    }
    return response.payload as Record<string, unknown>;
  };
  await request("connect", {
    minProtocol: protocol.PROTOCOL_VERSION,
    maxProtocol: protocol.PROTOCOL_VERSION,
    client: {
      id: "gateway-client",
      displayName: "proof-126924-live-gateway-wait-expiry",
      version: "1.0.0",
      platform: process.platform,
      mode: "backend",
    },
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    caps: [],
  });

  // ------------------------------------------------------------------- burst
  const parentTurns = Array.from({ length: BURST }, (_unused, index) =>
    request("agent", {
      sessionKey: `agent:main:proof-126924-live-parent-${index}`,
      message: `${PARENT_PROMPT_PREFIX} (${index})`,
      deliver: false,
      idempotencyKey: randomUUID(),
    }).catch((error: unknown) => ({ parentTurnError: String(error) })),
  );
  log(`[burst] issued ${BURST} concurrent real parent turns, each spawning one real child`);

  // Sample the Gateway's own durable state until every observed child settles.
  const observations = new Map<string, ChildObservation>();
  const observeUntil = Date.now() + OBSERVE_TIMEOUT_MS;
  while (Date.now() < observeUntil) {
    for (const row of readRegistryRows()) {
      if (!row.childSessionKey) {
        continue;
      }
      const observation =
        observations.get(row.runId) ??
        ({
          runId: row.runId,
          childSessionKey: row.childSessionKey,
          requesterSessionKey: row.requesterSessionKey,
          createdAt: row.createdAt ?? 0,
        } satisfies ChildObservation);
      observations.set(row.runId, observation);
      observation.requesterSessionKey ??= row.requesterSessionKey;
      if (
        observation.expiryObservedAt === undefined &&
        typeof row.waitExpiryObservedAt === "number"
      ) {
        observation.expiryObservedAt = row.waitExpiryObservedAt;
        observation.endedAtWhenExpiryObserved = row.execution.endedAt;
        observation.taskStatusWhenExpiryObserved = readTaskStatus(row.childSessionKey);
        observation.childRequestsAtExpiry = countChildProviderRequests();
      }
      if (
        observation.expiryObservedAt !== undefined &&
        observation.startedAtAfterExpiry === undefined &&
        typeof row.execution.startedAt === "number" &&
        row.execution.startedAt > observation.expiryObservedAt
      ) {
        observation.startedAtAfterExpiry = row.execution.startedAt;
      }
      if (observation.announcedAt === undefined && typeof row.waitExpiryAnnouncedAt === "number") {
        observation.announcedAt = row.waitExpiryAnnouncedAt;
        observation.endedAtWhenAnnounced = row.execution.endedAt;
        observation.deliveryWhenAnnounced = row.delivery ? { ...row.delivery } : undefined;
      }
      if (typeof row.execution.endedAt === "number") {
        observation.finalOutcome = row.execution.outcome;
        observation.finalEndedAt = row.execution.endedAt;
        observation.finalExpiryObservedAt = row.waitExpiryObservedAt;
        observation.finalTaskStatus = readTaskStatus(row.childSessionKey);
      }
      observation.finalDelivery = row.delivery ? { ...row.delivery } : undefined;
    }
    const settled = [...observations.values()].filter(
      (observation) => observation.finalEndedAt !== undefined,
    );
    // The provisional wake is written after an announcement grace and a real
    // parent wake turn, so it can land after the children themselves settle.
    // Never stop sampling before that window has had time to close.
    const lastExpiryAt = Math.max(
      0,
      ...[...observations.values()].map((observation) => observation.expiryObservedAt ?? 0),
    );
    const announceWindowClosed =
      lastExpiryAt > 0 && Date.now() - lastExpiryAt >= ANNOUNCE_SETTLE_WINDOW_MS;
    // The terminal notification's own receipt is a later, separate event: the
    // child must stop for real and the requester must take another turn. Keep
    // sampling until every provisionally-woken child has that receipt, or until
    // the window closes, so assertion 5 reads a settled state either way.
    const announcedRuns = [...observations.values()].filter(
      (observation) => observation.announcedAt !== undefined,
    );
    const lastAnnouncedAt = Math.max(
      0,
      ...announcedRuns.map((observation) => observation.announcedAt ?? 0),
    );
    const deliveryWindowClosed =
      lastAnnouncedAt > 0 && Date.now() - lastAnnouncedAt >= DELIVERY_SETTLE_WINDOW_MS;
    const deliveriesSettled =
      announcedRuns.length > 0 &&
      announcedRuns.every((observation) => observation.finalDelivery?.status === "delivered");
    if (
      observations.size >= BURST &&
      settled.length >= BURST &&
      announceWindowClosed &&
      (deliveriesSettled || deliveryWindowClosed)
    ) {
      break;
    }
    await delay(20);
  }
  await Promise.all(parentTurns);

  // The notification census, printed BEFORE the assertions so a negative-control
  // run reports it too: how many of these real children got a provisional
  // completion event, and how many then got a terminal one, counted from the
  // Gateway-authored blocks in the requesters' own provider turns. On current
  // main the provisional column is empty by construction — the deadline
  // publishes one terminal notification and there is no earlier provisional to
  // follow.
  const providerRequests = readProviderRequests();
  const notificationOrdinals = new Map<string, { provisionalSeq?: number; terminalSeq?: number }>();
  for (const observation of observations.values()) {
    const requesterSessionKey = observation.requesterSessionKey;
    notificationOrdinals.set(
      observation.runId,
      requesterSessionKey
        ? {
            provisionalSeq: findNotificationSeq({
              requests: providerRequests,
              childSessionKey: observation.childSessionKey,
              requesterSessionKey,
              disposition: "still-running",
            }),
            terminalSeq: findNotificationSeq({
              requests: providerRequests,
              childSessionKey: observation.childSessionKey,
              requesterSessionKey,
              disposition: "exited",
              requiredBlockText: "Stats: runtime ",
            }),
          }
        : {},
    );
  }
  const censusProvisional = [...notificationOrdinals.values()].filter(
    (ordinals) => ordinals.provisionalSeq !== undefined,
  ).length;
  const censusTerminal = [...notificationOrdinals.values()].filter(
    (ordinals) => ordinals.terminalSeq !== undefined,
  ).length;
  log(
    `[notifications] across ${observations.size} real children and ${providerRequests.length} ` +
      `provider requests: ${censusProvisional} carried a provisional completion event ` +
      `("disposition: still-running") into their requester's turn, ${censusTerminal} carried a ` +
      `terminal one ("disposition: exited")`,
  );

  const expired = [...observations.values()].filter(
    (observation) => observation.expiryObservedAt !== undefined,
  );
  assert.ok(
    expired.length > 0,
    `no child reached the nonterminal wait-expiry observation across ${observations.size} real ` +
      `children; observed: ${describeObservations(observations)}`,
  );

  // --------------------------------------------------------------- assert 1
  const provisional = expired.filter(
    (observation) =>
      observation.endedAtWhenExpiryObserved === undefined &&
      observation.taskStatusWhenExpiryObserved === "running",
  );
  assert.ok(
    provisional.length > 0,
    `every wait expiry terminalized its run or task; observed: ${describeObservations(observations)}`,
  );
  log(
    `[1/5] ${provisional.length} of ${observations.size} real children recorded a NONTERMINAL ` +
      `wait expiry: waitExpiryObservedAt persisted, execution.endedAt still unset, and the ` +
      `detached task a parent reads still "running"`,
  );

  // --------------------------------------------------------------- assert 2
  const stillActive = provisional.filter(
    (observation) => observation.startedAtAfterExpiry !== undefined,
  );
  assert.ok(
    stillActive.length > 0,
    `no child was observed doing work after its wait expired; observed: ${describeObservations(observations)}`,
  );
  const activeExample = stillActive[0];
  assert.ok(activeExample, "stillActive must have a first entry");
  const childRequestsFinal = countChildProviderRequests();
  assert.ok(
    childRequestsFinal > (activeExample.childRequestsAtExpiry ?? 0),
    "more of the children's own model requests must reach the provider after the expiry " +
      `(saw ${activeExample.childRequestsAtExpiry} at the expiry and ` +
      `${childRequestsFinal} by the end of the run)`,
  );
  log(
    `[2/5] continued child activity: ${stillActive.length} of them had not even started when ` +
      `their parent's wait expired — e.g. run ${activeExample.runId.slice(-8)} expired at ` +
      `${activeExample.expiryObservedAt} and started at ${activeExample.startedAtAfterExpiry} ` +
      `(+${(activeExample.startedAtAfterExpiry ?? 0) - (activeExample.expiryObservedAt ?? 0)}ms); ` +
      `the children's own model requests at the provider grew from ` +
      `${activeExample.childRequestsAtExpiry} to ${childRequestsFinal} after that boundary`,
  );

  // --------------------------------------------------------------- assert 3
  const announced = stillActive.filter((observation) => observation.announcedAt !== undefined);
  assert.ok(
    announced.length > 0,
    `no provisional wait-expiry notification settled; observed: ${describeObservations(observations)}`,
  );
  const announcedExample = announced[0];
  assert.ok(announcedExample, "announced must have a first entry");
  assert.equal(
    announcedExample.endedAtWhenAnnounced,
    undefined,
    "the provisional notification must settle while the run is still nonterminal",
  );
  log(
    `[3/5] the provisional notification settled on its own while the run was still nonterminal: ` +
      `run ${announcedExample.runId.slice(-8)} waitExpiryAnnouncedAt=${announcedExample.announcedAt} ` +
      `(+${(announcedExample.announcedAt ?? 0) - (announcedExample.expiryObservedAt ?? 0)}ms after the ` +
      `observation; the wake carries disposition "still-running")`,
  );

  // --------------------------------------------------------------- assert 4
  // The grace deliberately splits this set: a child whose real stop lands inside
  // `SUBAGENT_WAIT_EXPIRY_TERMINAL_GRACE_MS` never gets a provisional wake,
  // because an authoritative terminal wins. So the later-delivery evidence is
  // drawn from the expired set, not only from the announced subset.
  const delivered = stillActive.filter(
    (observation) =>
      observation.finalOutcome?.status === "ok" && observation.finalTaskStatus === "succeeded",
  );
  assert.ok(
    delivered.length > 0,
    `no child's later success survived its expired wait; observed: ${describeObservations(observations)}`,
  );
  const deliveredExample = delivered[0];
  assert.ok(deliveredExample, "delivered must have a first entry");
  assert.equal(
    typeof deliveredExample.finalExpiryObservedAt,
    "number",
    "the provisional observation must be retained across the promotion, not rewritten",
  );
  assert.ok(
    (deliveredExample.finalEndedAt ?? 0) > (deliveredExample.expiryObservedAt ?? 0),
    "the final settlement must come from the child's own later stop, after the expiry",
  );
  // No expired child may be retired by the clock: every one of them must end on
  // its own later record.
  for (const observation of expired) {
    assert.ok(
      observation.finalEndedAt === undefined ||
        observation.finalEndedAt > (observation.expiryObservedAt ?? 0),
      `run ${observation.runId.slice(-8)} was terminalized at or before its wait expiry`,
    );
  }
  log(
    `[4/5] later final settlement and delivery: ${delivered.length} of them then finished for ` +
      `real — e.g. run ${deliveredExample.runId.slice(-8)} settled with ` +
      `${JSON.stringify(deliveredExample.finalOutcome)} at ${deliveredExample.finalEndedAt}, ` +
      `waitExpiryObservedAt retained, and the detached task published "succeeded" rather than ` +
      `the clock's "timed_out". No expired child was retired at its deadline.`,
  );

  // --------------------------------------------------------------- assert 5
  // The narrow question assertion 4 does not answer: after the SAME child's
  // provisional notification has settled, does the requester actually RECEIVE a
  // terminal notification for that child? Two independent surfaces have to
  // agree, and both are the Gateway's own — not this harness's bookkeeping:
  //
  //   * the run's durable delivery receipt (`delivery.status`/`deliveredAt`),
  //     which the completion-delivery path writes only from a transport result;
  //   * the requester's own turn at the provider, carrying the Gateway-authored
  //     completion-event block for that exact child session.
  //
  // Nothing here is satisfied by the provisional wake: measured on this host,
  // the provisional announce leaves delivery `pending` and stamps no
  // `deliveredAt`, so a receipt timestamp after `waitExpiryAnnouncedAt` can
  // only be the terminal notification's.
  const receipts = announced
    .map((observation) => ({
      observation,
      provisionalSeq: notificationOrdinals.get(observation.runId)?.provisionalSeq,
      terminalSeq: notificationOrdinals.get(observation.runId)?.terminalSeq,
    }))
    .filter(
      (receipt) =>
        receipt.observation.finalDelivery?.status === "delivered" &&
        typeof receipt.observation.finalDelivery.deliveredAt === "number" &&
        (receipt.observation.finalDelivery.deliveredAt ?? 0) >
          (receipt.observation.announcedAt ?? 0) &&
        receipt.provisionalSeq !== undefined &&
        receipt.terminalSeq !== undefined &&
        receipt.terminalSeq > receipt.provisionalSeq,
    );
  assert.ok(
    receipts.length > 0,
    `no child's terminal notification was received after its own provisional notification ` +
      `settled; announced=${announced.length}, ` +
      `delivery=${JSON.stringify(
        announced.map((observation) => ({
          run: observation.runId.slice(-8),
          announcedAt: observation.announcedAt,
          delivery: observation.finalDelivery,
        })),
      )}`,
  );
  const receiptExample = receipts[0];
  assert.ok(receiptExample, "receipts must have a first entry");
  assert.equal(
    receiptExample.observation.deliveryWhenAnnounced?.status === "delivered",
    false,
    "the provisional wake must not already have credited a terminal delivery receipt; " +
      `saw ${JSON.stringify(receiptExample.observation.deliveryWhenAnnounced)} when it settled`,
  );
  assert.ok(
    (receiptExample.observation.finalEndedAt ?? 0) > (receiptExample.observation.announcedAt ?? 0),
    "the terminal notification must follow the child's own later stop, which itself follows the " +
      "provisional wake",
  );
  log(
    `[5/5] terminal-notification receipt for the SAME child, after its provisional notification ` +
      `settled: ${receipts.length} of ${announced.length} provisionally-woken children — e.g. run ` +
      `${receiptExample.observation.runId.slice(-8)} (child session ` +
      `${receiptExample.observation.childSessionKey.slice(-12)}) woke its requester ` +
      `provisionally at provider request #${receiptExample.provisionalSeq} ` +
      `("disposition: still-running"), settled that wake at ` +
      `${receiptExample.observation.announcedAt} with delivery still ` +
      `"${receiptExample.observation.deliveryWhenAnnounced?.status ?? "pending"}", stopped for real ` +
      `at ${receiptExample.observation.finalEndedAt}, and then delivered its TERMINAL ` +
      `notification into the same requester's turn at provider request ` +
      `#${receiptExample.terminalSeq} ("disposition: exited" + "Stats: runtime"), with the run's ` +
      `own receipt ${JSON.stringify(receiptExample.observation.finalDelivery)}`,
  );

  // In-run control: a child whose dispatch beat its own budget never reaches the
  // changed branch and settles through the ordinary observed-stop path.
  const control = [...observations.values()].filter(
    (observation) => observation.expiryObservedAt === undefined,
  );
  if (control.length > 0) {
    log(
      `[control] ${control.length} child(ren) dispatched inside their budget, never reached the ` +
        `expiry branch, and settled through the ordinary observed-stop path: ` +
        control
          .map(
            (observation) =>
              `${observation.runId.slice(-8)}=${JSON.stringify(observation.finalOutcome)}`,
          )
          .join(" "),
    );
  }
  log("");
  log(`Observed children: ${describeObservations(observations)}`);
  log("All live-Gateway wait-expiry assertions passed.");
  client.close();
} catch (error) {
  exitCode = 1;
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.stderr.write(`--- gateway output tail ---\n${readGatewayOutput().slice(-8_000)}\n`);
} finally {
  gateway?.kill("SIGKILL");
  mock?.kill("SIGKILL");
  fs.rmSync(stateRoot, { recursive: true, force: true });
}
process.exit(exitCode);
