/**
 * Real-runtime EXECUTION proof for PR #142306 — companion to
 * `proof-142306-queued-admission-authority.ts`, which stops at the routing decision.
 *
 * This harness runs a queued follow-up turn all the way through `executeFollowupTurn`
 * against a real agent runtime, and then lets the real follow-up drain execute the
 * surviving queued messages. It answers the remaining review ask: after-fix EXECUTION
 * evidence, and the observable benefit over current `main`.
 *
 * What is REAL here (no vitest, no module mocks, no stubbed seam):
 *   - `admitFollowupTurn` and `executeFollowupTurn` — the exact two steps, in order, that
 *     production's own drain owner `createFollowupRunner` performs for every queued turn.
 *     The harness calls them separately for one reason only: the window this PR changes
 *     lives BETWEEN them, and racing a millisecond-wide window from inside the runner
 *     would be non-deterministic.
 *   - `executeFollowupTurn` drives the real embedded agent runner: real model resolution,
 *     real prompt build, real attempt dispatch, real `attachBackend`, real streaming
 *     transport. The turn really reaches `phase === "running"` with an injectable backend,
 *     which is asserted from production state while it runs.
 *   - `runReplyAgent` decides, for each message arriving during the window, whether to
 *     steer it into the in-flight turn or queue it as its own turn.
 *   - the real follow-up queue, the real overflow policy (`applyQueueDropPolicy`, whose
 *     `isProtected` predicate skips `steerAnchor` items), and the real drain owner
 *     `createFollowupRunner`, which production registers as the queue's executor.
 *
 * What is stubbed, and only at the very edge:
 *   - the MODEL ENDPOINT. A `node:http` server on 127.0.0.1 speaks the OpenAI Responses
 *     streaming wire format and is reached through an ordinary `models.providers` entry —
 *     the same shape `src/gateway/test-openai-responses-model.ts` uses for gateway HTTP
 *     tests. No credential, no external network. Everything between the queue and that
 *     socket is production code, and the server's request log is the evidence of which
 *     user prompts were actually executed.
 *   - the channel transport (typing controller with no callbacks).
 *
 * Queue admission inputs are PRODUCTION-DERIVED, not asserted:
 *   - `resolvedQueue` is not hand-written. It is whatever production's own
 *     `resolveQueueSettingsCore` resolves from the harness config, called the same way
 *     `get-reply-run-admission.ts:358` calls it. The config sets no queue mode, so the mode
 *     is OpenClaw's documented default `steer` (docs/concepts/queue.md, "Defaults").
 *     That matters: `shouldSteer` is computed only for `resolvedQueue.mode === "steer"`
 *     (`get-reply-run-admission.ts:562-570`), so `steer` is the mode in which the benefit
 *     measured below is reachable at all. Under `followup` no message is ever steered, so
 *     no `steerAnchor` exists on either tree and this overflow difference does not arise.
 *   - `queueAdmissionState` is recomputed before every inbound message by production's own
 *     `resolveReplyQueueAdmissionState`, applied to the live follow-up queue and the live
 *     active reply operation — the same call `get-reply-run-admission.ts:557` makes.
 *   - `shouldSteer` and `shouldFollowup` are then production's conjunctions over that state
 *     (`get-reply-run-admission.ts:562-576`). The conjuncts held constant by this fixture
 *     are named at the call site, and each is a property of the fixture rather than an
 *     override: an ordinary CLI user message is not a room event and not a heartbeat, no
 *     reset is triggered, no recovery owner is registered, and
 *     `resolveActiveRunAcceptsCurrentThread` returns true for every non-Slack route
 *     (`get-reply-run-admission.ts:474-480`).
 *   - `cap: 2` and `drop: "old"` are ordinary `messages.queue` config values read through
 *     that same resolver. The cap only decides how many messages are needed to reach
 *     overflow (the default 20 would need twenty-one); `drop: "old"` makes the loss
 *     observable as a discarded message instead of a summary line. `applyQueueDropPolicy`
 *     consults the same `isProtected` predicate under every drop policy
 *     (`queue/enqueue.ts:238`).
 *
 * Scenarios:
 *   1. a queued turn is admitted and owns its tool authority BEFORE execution.
 *   2. a same-authority follow-up arriving in that window is routed into the steer path
 *      and parked with `steerAnchor` (the parked steer then falls back — asserted — because
 *      the turn is not running yet; this harness does not claim a completed injection).
 *   3. a four-message burst overflows the queue during that window. `steerAnchor` is a
 *      protected identity for overflow, so the window follow-up survives and a later,
 *      unprotected message is evicted instead.
 *   4. the admitted turn EXECUTES for real: it reaches `running` with an injectable
 *      backend, the provider receives its prompt, and the run settles ok.
 *   5. after that turn completes, the real drain EXECUTES the survivors. The provider's
 *      request log shows the window follow-up was answered.
 *
 * Run: pnpm tsx scripts/proof-142306-queued-execution-benefit.ts
 *
 * Against pristine `origin/main` (execution-time binding) this harness exits 1: nothing is
 * bound at admission, so the window follow-up is never routed into the steer path, never
 * gains `steerAnchor`, is evicted by the same overflow burst as the OLDEST unprotected
 * item, and is therefore never executed — the provider never sees its prompt. Scenario 4
 * and the later message's execution still pass on `main`, so the control discriminates
 * rather than failing uniformly.
 *
 * SCOPE, stated plainly: this harness does NOT show a successful steer injection that
 * `main` lacks, and does not claim one. Injection requires `phase === "running"` with an
 * attached backend (`resolveReplyMessageInjectionRejection` rejects `not_running` first),
 * and by the time a queued turn is running BOTH trees own a snapshot. The difference this
 * PR creates is confined to the admission→running window, and that is what is measured.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const proofHome = mkdtempSync(path.join(tmpdir(), "proof-142306-exec-"));
process.env.OPENCLAW_HOME = proofHome;
process.env.OPENCLAW_STATE_DIR = path.join(proofHome, "state");
process.env.OPENCLAW_CONFIG_PATH = path.join(proofHome, "state", "openclaw.json");
process.env.OPENCLAW_DISABLE_PLUGINS = "1";
mkdirSync(path.join(proofHome, "state"), { recursive: true });
mkdirSync(path.join(proofHome, "workspace"), { recursive: true });

const PROVIDER_ID = "mock-openai";
const MODEL_ID = "gpt-5.4";
const SESSION_KEY = "proof:142306-exec";
const SESSION_ID = "proof-142306-exec-session";
const WORKSPACE_DIR = path.join(proofHome, "workspace");
const AGENT_DIR = path.join(proofHome, "agent");

/** Unique per-message markers so the provider request log identifies what actually ran. */
const MARKER_ADMITTED = "PROOF142306_ADMITTED_TURN";
const MARKER_WINDOW = "PROOF142306_WINDOW_FOLLOWUP";
const MARKER_SECOND = "PROOF142306_LATER_SECOND";
const MARKER_THIRD = "PROOF142306_LATER_THIRD";
const MARKER_FOURTH = "PROOF142306_LATER_FOURTH";

let checks = 0;
const failures: string[] = [];

/**
 * Records rather than throws so one run reports EVERY degradation. The process still exits
 * non-zero when anything failed; see the tail of `main()`.
 */
function ok(label: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (condition) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures.push(label);
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
}

/** Structural preconditions: without these the rest of the run would observe nothing. */
function mustHold(label: string, condition: boolean, detail?: string): void {
  ok(label, condition, detail);
  if (!condition) {
    throw new Error(`PRECONDITION FAILED: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * A real HTTP endpoint speaking the OpenAI Responses streaming format. This is the single
 * edge stub: production reaches it through an ordinary configured provider, and its request
 * log is the record of which prompts the agent runtime actually executed.
 */
function startModelEndpoint(requestBodies: string[]): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      requestBodies.push(body);
      const events = [
        {
          type: "response.output_item.added",
          item: {
            type: "message",
            id: "msg_proof",
            role: "assistant",
            content: [],
            status: "in_progress",
          },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            id: "msg_proof",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "acknowledged", annotations: [] }],
          },
        },
        {
          type: "response.completed",
          response: {
            status: "completed",
            usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
          },
        },
      ];
      const sse = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

async function main(server: { server: Server; baseUrl: string }, requestBodies: string[]) {
  type AnyRecord = Record<string, unknown>;

  const config = {
    agents: { entries: { main: { workspace: WORKSPACE_DIR } } },
    // Ordinary queue config. `mode` is deliberately absent so production's resolver supplies
    // OpenClaw's default (`steer`); `cap`/`drop`/`debounceMsByChannel` are the documented
    // `messages.queue` knobs.
    messages: {
      queue: { cap: 2, drop: "old", debounceMsByChannel: { cli: 0 } },
    },
    models: {
      providers: {
        [PROVIDER_ID]: {
          baseUrl: server.baseUrl,
          apiKey: "test",
          api: "openai-responses",
          models: [
            {
              id: MODEL_ID,
              name: MODEL_ID,
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
  } as AnyRecord;
  writeFileSync(process.env.OPENCLAW_CONFIG_PATH as string, `${JSON.stringify(config, null, 2)}\n`);

  // Every OpenClaw import is dynamic so the isolated home above is set first.
  const { admitFollowupTurn } = await import("../src/auto-reply/reply/followup-turn-admission.js");
  const { executeFollowupTurn } =
    await import("../src/auto-reply/reply/followup-turn-execution.js");
  const { runReplyAgent } = await import("../src/auto-reply/reply/agent-runner-run.js");
  const { replyRunRegistry, isReplyRunActiveForSessionId } =
    await import("../src/auto-reply/reply/reply-run-registry.js");
  const { getExistingFollowupQueue } = await import("../src/auto-reply/reply/queue/state.js");
  const { createTypingController } = await import("../src/auto-reply/reply/typing.js");
  const { resolveQueueSettingsCore } = await import("../src/auto-reply/reply/queue/settings.js");
  const { resolveReplyQueueAdmissionState } =
    await import("../src/auto-reply/reply/queue-policy.js");

  const sessionEntry = {
    agent: "main",
    sessionId: SESSION_ID,
    lifecycleRevision: 1,
    updatedAt: Date.now(),
    permissionMode: "workspace",
  } as AnyRecord;
  const sessionStore: AnyRecord = { [SESSION_KEY]: sessionEntry };

  const dispositions = new Map<string, string>();

  const makeRun = (params: {
    prompt: string;
    messageId: string;
    disableTools?: boolean;
  }): AnyRecord => ({
    prompt: params.prompt,
    messageId: params.messageId,
    enqueuedAt: Date.now(),
    originatingChannel: "cli",
    onQueueDisposition: (disposition: string) => {
      dispositions.set(params.messageId, disposition);
    },
    ...(params.disableTools === true ? { disableTools: true } : {}),
    run: {
      agentId: "main",
      agentDir: AGENT_DIR,
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      // Production resolves an inbound run's session marker to the scoped session key
      // (get-reply-run-admission.ts: "Queued admission uses the scoped key too").
      sessionFile: SESSION_KEY,
      workspaceDir: WORKSPACE_DIR,
      cwd: WORKSPACE_DIR,
      config,
      provider: PROVIDER_ID,
      model: MODEL_ID,
      messageProvider: "cli",
      permissionMode: "workspace",
      timeoutMs: 120_000,
      blockReplyBreak: "message_end",
      ...(params.disableTools === true ? { disableTools: true } : {}),
    },
  });

  const defaults = {
    typing: createTypingController({}),
    typingMode: "never" as const,
    defaultModel: `${PROVIDER_ID}/${MODEL_ID}`,
    sessionKey: SESSION_KEY,
    sessionEntry,
    sessionStore,
  };

  // ---------------------------------------------------------------- scenario 0
  console.log("[0] production resolves the queue settings this run is measured under");

  // Production's own resolver decides the queue settings, called exactly as
  // `get-reply-run-admission.ts:358` calls it. Nothing here asserts a mode: the config sets
  // none, so this is whatever OpenClaw uses by default for a CLI turn.
  const resolvedQueue = resolveQueueSettingsCore({
    cfg: config as never,
    channel: "cli",
    sessionEntry: sessionEntry as never,
  });
  console.log(
    `queue settings resolved by production: mode=${resolvedQueue.mode} cap=${String(resolvedQueue.cap)} drop=${String(resolvedQueue.dropPolicy)} debounceMs=${String(resolvedQueue.debounceMs)}`,
  );
  mustHold(
    "production resolved the default queue mode `steer`, the only mode that computes steering",
    resolvedQueue.mode === "steer",
    `mode=${resolvedQueue.mode} — get-reply-run-admission.ts:570 requires "steer" before shouldSteer can be true`,
  );

  const queueItems = (): AnyRecord[] =>
    ((getExistingFollowupQueue(SESSION_KEY) as AnyRecord | undefined)?.items ?? []) as AnyRecord[];

  const queueItem = (messageId: string): AnyRecord | undefined =>
    queueItems().find((item) => (item.messageId as string) === messageId);

  type InboundOutcome = { settled: boolean; error: string };

  /**
   * Reproduces production's admission computation for an inbound CLI user message instead of
   * asserting its outputs. `queueAdmissionState` is production's own function over the live
   * queue and live active operation (`get-reply-run-admission.ts:557`); `shouldSteer` and
   * `shouldFollowup` are production's conjunctions (`:562` and `:571`). The conjuncts fixed by
   * this fixture are each a property of it: a CLI user message is neither a room event nor a
   * heartbeat, nothing triggers a reset or preempts a heartbeat, no recovery owner is
   * registered for this store, and `resolveActiveRunAcceptsCurrentThread` returns true for any
   * route that is not a Slack direct-routed thread turn (`:474-480`).
   */
  const resolveAdmissionInputs = () => {
    const queueAdmissionState = resolveReplyQueueAdmissionState(
      getExistingFollowupQueue(SESSION_KEY),
      replyRunRegistry.get(SESSION_KEY),
    );
    return {
      queueAdmissionState,
      isActive: isReplyRunActiveForSessionId(SESSION_ID),
      shouldSteer: queueAdmissionState !== "ready" && resolvedQueue.mode === "steer",
      shouldFollowup:
        resolvedQueue.mode === "steer" ||
        resolvedQueue.mode === "followup" ||
        resolvedQueue.mode === "collect",
    };
  };

  const deliverInbound = async (run: AnyRecord): Promise<InboundOutcome> => {
    const outcome: InboundOutcome = { settled: false, error: "" };
    const admissionInputs = resolveAdmissionInputs();
    console.log(
      `  admission inputs for ${String(run.messageId)} (derived from the live queue): state=${admissionInputs.queueAdmissionState} shouldSteer=${String(admissionInputs.shouldSteer)} isActive=${String(admissionInputs.isActive)}`,
    );
    const settled = runReplyAgent({
      commandBody: run.prompt as string,
      followupRun: run as never,
      queueKey: SESSION_KEY,
      resolvedQueue: resolvedQueue as never,
      shouldSteer: admissionInputs.shouldSteer,
      shouldFollowup: admissionInputs.shouldFollowup,
      queueAdmissionState: admissionInputs.queueAdmissionState,
      isActive: admissionInputs.isActive,
      typing: createTypingController({}),
      sessionEntry: sessionEntry as never,
      sessionStore: sessionStore as never,
      sessionKey: SESSION_KEY,
      defaultModel: `${PROVIDER_ID}/${MODEL_ID}`,
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      sessionCtx: { Provider: "cli", OriginatingChannel: "cli" } as never,
      shouldInjectGroupIntro: false,
      typingMode: "never",
    } as never).then(
      () => {
        outcome.settled = true;
      },
      (error: unknown) => {
        outcome.settled = true;
        outcome.error = error instanceof Error ? error.message : String(error);
      },
    );
    // Failures and timeouts are reported, never swallowed.
    await Promise.race([settled, sleep(10_000)]);
    return outcome;
  };

  const providerSaw = (marker: string): boolean =>
    requestBodies.some((body) => body.includes(marker));

  const waitForProvider = async (marker: string, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (providerSaw(marker)) {
        return true;
      }
      await sleep(250);
    }
    return providerSaw(marker);
  };

  // ---------------------------------------------------------------- scenario 1
  console.log("");
  console.log("[1] a queued turn is admitted and owns its tool authority before execution");

  const admittedRun = makeRun({ prompt: MARKER_ADMITTED, messageId: "proof-exec-1" });
  const admission = (await admitFollowupTurn({
    queued: admittedRun as never,
    defaults: defaults as never,
  })) as AnyRecord;

  mustHold(
    "real admitFollowupTurn admitted the queued turn",
    admission.kind === "admitted",
    `admission.kind=${String(admission.kind)} reason=${JSON.stringify(admission.reason ?? null)}`,
  );

  const turn = admission.turn as AnyRecord;
  const operation = turn.operation as AnyRecord & {
    toolAuthorityFingerprint?: string;
    phase: string;
    complete: () => void;
  };

  mustHold(
    "the admitted operation is the session's active reply run",
    replyRunRegistry.get(SESSION_KEY) === operation,
  );
  ok(
    "the admitted turn has NOT started executing yet",
    operation.phase !== "running",
    `phase=${operation.phase}`,
  );
  const admittedFingerprint = operation.toolAuthorityFingerprint;
  ok(
    "the admitted queued turn owns a tool authority fingerprint before execution",
    typeof admittedFingerprint === "string" && /^[0-9a-f]{64}$/.test(admittedFingerprint),
    `toolAuthorityFingerprint=${String(admittedFingerprint)} (undefined here means the binding happens at execution, not admission)`,
  );

  // ---------------------------------------------------------------- scenario 2
  console.log("");
  console.log("[2] a same-authority follow-up arriving in that window reaches the steer path");

  const windowRun = makeRun({ prompt: MARKER_WINDOW, messageId: "proof-exec-2" });
  const windowOutcome = await deliverInbound(windowRun);
  ok(
    "the window follow-up's inbound turn ran to completion without error",
    windowOutcome.settled && windowOutcome.error === "",
    `settled=${windowOutcome.settled} error=${windowOutcome.error || "(none)"}`,
  );
  const windowItem = queueItem("proof-exec-2");
  mustHold("the window follow-up reached the real follow-up queue", windowItem !== undefined);
  ok(
    "the window follow-up was ROUTED INTO the steer path and parked with steerAnchor",
    windowItem?.steerAnchor === true,
    "steerAnchor is absent, so production skipped runActiveReplySteer and enqueued the message as a plain queued turn",
  );
  ok(
    "that parked steer then falls back, because the admitted turn is not running yet",
    windowItem?.steerPending === undefined,
    `steerPending=${JSON.stringify(windowItem?.steerPending ?? null)} — this harness expects fallback and must not imply a completed injection`,
  );

  // ---------------------------------------------------------------- scenario 3
  console.log("");
  console.log("[3] a burst overflows the queue during the same window");

  const secondRun = makeRun({
    prompt: MARKER_SECOND,
    messageId: "proof-exec-3",
    disableTools: true,
  });
  const thirdRun = makeRun({
    prompt: MARKER_THIRD,
    messageId: "proof-exec-4",
    disableTools: true,
  });
  const fourthRun = makeRun({
    prompt: MARKER_FOURTH,
    messageId: "proof-exec-5",
    disableTools: true,
  });
  const laterOutcomes = [
    await deliverInbound(secondRun),
    await deliverInbound(thirdRun),
    await deliverInbound(fourthRun),
  ];
  ok(
    "every later inbound turn ran to completion without error",
    laterOutcomes.every((outcome) => outcome.settled && outcome.error === ""),
    laterOutcomes.map((outcome) => outcome.error || "(none)").join(" | "),
  );
  const liveQueue = getExistingFollowupQueue(SESSION_KEY) as AnyRecord | undefined;
  const survivors = queueItems().map((item) => String(item.messageId));
  console.log(
    `  queue settings in effect: cap=${String(liveQueue?.cap)} dropPolicy=${String(liveQueue?.dropPolicy)} inFlight=${String((liveQueue?.inFlight as Set<unknown> | undefined)?.size)}`,
  );
  console.log(`  queue after the burst: [${survivors.join(", ")}]`);
  console.log(
    `  queue dispositions: ${JSON.stringify(Object.fromEntries(dispositions.entries()))}`,
  );
  ok(
    "the follow-up that arrived during the preflight window SURVIVED queue overflow",
    survivors.includes("proof-exec-2"),
    `it was evicted with disposition=${dispositions.get("proof-exec-2") ?? "(none)"}; steerAnchor is what protects it in applyQueueDropPolicy`,
  );
  ok(
    "overflow evicted a later, unprotected message instead",
    ["proof-exec-3", "proof-exec-4", "proof-exec-5"].some(
      (id) => dispositions.get(id) === "queue-cap-old",
    ),
    `no later message reports queue-cap-old, so this burst never reached the overflow policy`,
  );

  // ---------------------------------------------------------------- scenario 4
  console.log("");
  console.log("[4] the admitted turn EXECUTES for real against the agent runtime");

  let runningFingerprint: string | undefined;
  let sawInjectableTarget = false;
  const watcher = (async () => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const active = replyRunRegistry.get(SESSION_KEY) as AnyRecord | undefined;
      if (active && active.phase === "running") {
        runningFingerprint ??= active.toolAuthorityFingerprint as string | undefined;
        if (replyRunRegistry.resolveCurrentMessageInjectionTarget(SESSION_KEY) !== undefined) {
          sawInjectableTarget = true;
          return;
        }
      }
      await sleep(25);
    }
  })();

  const execution = (await executeFollowupTurn({
    turn: turn as never,
    defaults: defaults as never,
    onToolResult: async () => undefined,
    onCompactionNoticePayload: async () => undefined,
  })) as AnyRecord;
  await watcher;

  const outcome = (execution.execution as AnyRecord | undefined)?.outcome as AnyRecord | undefined;
  mustHold(
    "the queued turn executed and settled successfully",
    outcome?.kind === "settled" && outcome.status === "ok",
    `outcome=${JSON.stringify(outcome ?? null).slice(0, 400)}`,
  );
  ok(
    "the provider really received the admitted turn's prompt",
    providerSaw(MARKER_ADMITTED),
    `provider requests=${requestBodies.length}`,
  );
  ok(
    "the executing turn reached running WITH an injectable backend attached",
    sawInjectableTarget,
    `runningFingerprint=${String(runningFingerprint)} — resolveCurrentMessageInjectionTarget never became defined`,
  );

  // ---------------------------------------------------------------- scenario 5
  console.log("");
  console.log("[5] the real drain then EXECUTES the surviving queued messages");

  // Production's drain owner completes the operation at the end of every queued turn;
  // this harness performs the same terminal step so the queue can drain behind it.
  operation.complete();

  const windowExecuted = await waitForProvider(MARKER_WINDOW, 120_000);
  const laterExecuted = await waitForProvider(MARKER_FOURTH, 120_000);
  ok(
    "the window follow-up was EXECUTED by the real follow-up drain",
    windowExecuted,
    "the provider never received its prompt, so the user's message was never answered",
  );
  ok(
    "a later surviving message was also executed (the drain works on both trees)",
    laterExecuted,
    "the drain never executed the later message either, so this run does not discriminate",
  );

  console.log("");
  console.log(`provider requests observed: ${requestBodies.length}`);
  for (const marker of [
    MARKER_ADMITTED,
    MARKER_WINDOW,
    MARKER_SECOND,
    MARKER_THIRD,
    MARKER_FOURTH,
  ]) {
    console.log(`  ${providerSaw(marker) ? "executed  " : "NOT run   "} ${marker}`);
  }

  console.log("");
  if (failures.length > 0) {
    throw new Error(`${failures.length} of ${checks} runtime assertions failed`);
  }
  console.log(`All runtime assertions passed. (${checks} checks)`);
}

const requestBodies: string[] = [];
startModelEndpoint(requestBodies)
  .then(async (endpoint) => {
    try {
      await main(endpoint, requestBodies);
      endpoint.server.close();
      rmSync(proofHome, { recursive: true, force: true });
      process.exit(0);
    } catch (error) {
      console.log(`PROOF FAILED after ${checks} checks: ${String(error)}`);
      if (failures.length > 0) {
        console.log("Failed assertions:");
        for (const failure of failures) {
          console.log(`  - ${failure}`);
        }
      }
      endpoint.server.close();
      rmSync(proofHome, { recursive: true, force: true });
      process.exit(1);
    }
  })
  .catch((error: unknown) => {
    console.log(`PROOF FAILED to start: ${String(error)}`);
    rmSync(proofHome, { recursive: true, force: true });
    process.exit(1);
  });
