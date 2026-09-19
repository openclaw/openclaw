/**
 * Real-runtime proof for PR #142306 — queued follow-up tool authority is owned by
 * admission, before preflight, rather than by execution.
 *
 * What is REAL here (no vitest, no module mocks, no stubbed seam):
 *   - `admitFollowupTurn` (src/auto-reply/reply/followup-turn-admission.ts) runs unmodified,
 *     including the real `admitReplyTurn` lane admission, the real reply-run registry, the
 *     real send-policy resolution and the real preflight compaction check.
 *   - `runReplyAgent` (src/auto-reply/reply/agent-runner-run.ts) runs unmodified for the
 *     second inbound message. It is the production code that decides, for a message arriving
 *     while a run is active, whether to steer it into the active turn or queue it as its own
 *     follow-up turn. That decision reads `operation.toolAuthorityFingerprint` off the real
 *     registry.
 *   - `resolveFollowupRunToolAuthorityFingerprint` / `prepareReplyToolAuthority`
 *     (src/auto-reply/reply/reply-tool-authority.ts) are the real fingerprint functions.
 *   - The observation is real production state: the follow-up queue owned by
 *     `src/auto-reply/reply/queue/state.ts`. A message routed into `runActiveReplySteer` is
 *     parked with `steerAnchor`; a message that skipped that path never gets one.
 *
 * What is stubbed, and only at the very edge:
 *   - the channel transport (typing controller callbacks, delivery) — nothing between
 *     admission and the queue decision is stubbed.
 *   - no model is called: the admitted turn is deliberately held in its post-admission,
 *     pre-execution window, which is exactly the window this PR moves the binding into.
 *
 * Queue admission inputs are PRODUCTION-DERIVED, not asserted:
 *   - `resolvedQueue` comes from production's own `resolveQueueSettingsCore`, called the way
 *     `get-reply-run-admission.ts:358` calls it, over a config that sets no queue mode. The
 *     mode is therefore OpenClaw's documented default `steer` (docs/concepts/queue.md,
 *     "Defaults") — and `steer` is the only mode for which production computes steering at
 *     all (`get-reply-run-admission.ts:562-570`).
 *   - `queueAdmissionState` is recomputed before each inbound message by production's own
 *     `resolveReplyQueueAdmissionState` over the live queue and live active operation, the
 *     same call `get-reply-run-admission.ts:557` makes.
 *   - `shouldSteer`/`shouldFollowup` are production's conjunctions over that state; the
 *     conjuncts this fixture holds constant are named at the call site.
 *
 * Scenarios:
 *   1. fresh queued admission — an admitted turn owns a tool authority fingerprint before
 *      execution, that fingerprint is the one an identical inbound message computes, and the
 *      route bind execution performs resolves against it.
 *   2. benefit — a same-authority follow-up arriving during that window is ROUTED INTO the
 *      steer path for the in-flight turn instead of being enqueued as its own turn. SCOPE: the
 *      harness proves the routing decision, which is what this PR changes. It deliberately
 *      holds the admitted turn pre-execution, so no backend is attached and the parked steer
 *      then falls back — asserted explicitly, so no completed steer is implied.
 *   3. discrimination control — a different-authority follow-up arriving in the same window
 *      is NOT routed into the steer path; it is enqueued as its own turn. This proves
 *      scenario 2 observes a real authority comparison rather than a constant.
 *   4. immutability — a later bind cannot replace the admitted turn's authority. Runs last
 *      because it deliberately attempts a mutation.
 *
 * Run: pnpm tsx scripts/proof-142306-queued-admission-authority.ts
 *
 * Against `origin/main` (execution-time binding) this harness exits 1, including the literal
 * production error this PR fixes — "Reply operation has no active tool authority snapshot" —
 * and the same-authority follow-up never reaching the steer path at all.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const proofHome = mkdtempSync(path.join(tmpdir(), "proof-142306-"));
process.env.OPENCLAW_HOME = proofHome;
process.env.OPENCLAW_STATE_DIR = path.join(proofHome, "state");
process.env.OPENCLAW_DISABLE_PLUGINS = "1";

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

async function main(): Promise<void> {
  // Every OpenClaw import is dynamic so the isolated home above is set first.
  const { admitFollowupTurn } = await import("../src/auto-reply/reply/followup-turn-admission.js");
  const { runReplyAgent } = await import("../src/auto-reply/reply/agent-runner-run.js");
  const { replyRunRegistry } = await import("../src/auto-reply/reply/reply-run-registry.js");
  const { isReplyRunActiveForSessionId } =
    await import("../src/auto-reply/reply/reply-run-registry.js");
  const { prepareReplyToolAuthority, resolveFollowupRunToolAuthorityFingerprint } =
    await import("../src/auto-reply/reply/reply-tool-authority.js");
  const { getExistingFollowupQueue } = await import("../src/auto-reply/reply/queue/state.js");
  const { createTypingController } = await import("../src/auto-reply/reply/typing.js");
  const { resolveQueueSettingsCore } = await import("../src/auto-reply/reply/queue/settings.js");
  const { resolveReplyQueueAdmissionState } =
    await import("../src/auto-reply/reply/queue-policy.js");

  type AnyRecord = Record<string, unknown>;

  const SESSION_KEY = "proof:142306";
  const SESSION_ID = "proof-142306-session";
  const AGENT_DIR = path.join(proofHome, "agent");
  const WORKSPACE_DIR = path.join(proofHome, "workspace");

  const sessionEntry = {
    agent: "main",
    sessionId: SESSION_ID,
    lifecycleRevision: 1,
    updatedAt: Date.now(),
    permissionMode: "default",
  } as AnyRecord;
  const sessionStore: AnyRecord = { [SESSION_KEY]: sessionEntry };

  // Ordinary config. `messages.queue.mode` is deliberately absent so production's own
  // resolver supplies OpenClaw's default mode; only the CLI debounce is pinned so the
  // harness does not wait on the 500 ms default quiet window.
  const config = {
    agents: { defaults: {} },
    messages: { queue: { debounceMsByChannel: { cli: 0 } } },
  } as AnyRecord;

  // Resolved the way `get-reply-run-admission.ts:358` resolves it, not hand-written.
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

  const makeRun = (params: {
    prompt: string;
    messageId: string;
    disableTools?: boolean;
    toolsAllow?: string[];
  }): AnyRecord => ({
    prompt: params.prompt,
    messageId: params.messageId,
    enqueuedAt: Date.now(),
    ...(params.disableTools === true ? { disableTools: true } : {}),
    ...(params.toolsAllow ? { toolsAllow: params.toolsAllow } : {}),
    originatingChannel: "cli",
    run: {
      agentId: "main",
      agentDir: AGENT_DIR,
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      // Production resolves an inbound run's session marker to the scoped session key
      // (get-reply-run-admission.ts: "Queued admission uses the scoped key too"), which is
      // also what `resolveAdmittedRunSessionFile` produces for the admitted queued turn.
      sessionFile: SESSION_KEY,
      workspaceDir: WORKSPACE_DIR,
      cwd: WORKSPACE_DIR,
      config,
      provider: "anthropic",
      model: "claude-proof",
      messageProvider: "cli",
      permissionMode: "default",
      timeoutMs: 5_000,
      blockReplyBreak: "message_end",
      ...(params.disableTools === true ? { disableTools: true } : {}),
      ...(params.toolsAllow ? { toolsAllow: params.toolsAllow } : {}),
    },
  });

  const defaults = {
    typing: createTypingController({}),
    typingMode: "never" as const,
    defaultModel: "claude-proof",
    sessionKey: SESSION_KEY,
    sessionEntry,
    sessionStore,
  };

  // ---------------------------------------------------------------- scenario 1
  console.log("[1] fresh queued admission owns tool authority before execution");

  const admittedRun = makeRun({ prompt: "first queued follow-up", messageId: "proof-msg-1" });
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
    bindToolAuthoritySnapshot: (snapshot: unknown) => void;
    bindToolAuthorityRoute: (route: { provider: string; model: string }) => string;
    complete: (...args: unknown[]) => unknown;
    fail: (...args: unknown[]) => unknown;
  };

  mustHold(
    "the admitted operation is the session's active reply run",
    replyRunRegistry.get(SESSION_KEY) === operation,
  );
  ok(
    "the admitted turn has NOT started executing",
    operation.phase !== "running",
    `phase=${operation.phase}`,
  );

  const admittedFingerprint = operation.toolAuthorityFingerprint;
  ok(
    "admitted queued turn owns a tool authority fingerprint before execution",
    typeof admittedFingerprint === "string" && /^[0-9a-f]{64}$/.test(admittedFingerprint),
    `toolAuthorityFingerprint=${String(admittedFingerprint)} (undefined here means the binding happens at execution, not admission)`,
  );

  const sameAuthorityRun = makeRun({
    prompt: "same-authority follow-up",
    messageId: "proof-msg-2",
  });
  const sameAuthorityFingerprint = resolveFollowupRunToolAuthorityFingerprint(
    sameAuthorityRun as never,
  ) as string;
  ok(
    "an identical inbound message computes the SAME fingerprint the admitted turn owns",
    sameAuthorityFingerprint === admittedFingerprint,
  );

  const otherAuthorityRun = makeRun({
    prompt: "different-authority follow-up",
    messageId: "proof-msg-3",
    disableTools: true,
  });
  const otherAuthorityFingerprint = resolveFollowupRunToolAuthorityFingerprint(
    otherAuthorityRun as never,
  ) as string;
  ok(
    "a different-authority inbound message computes a DIFFERENT fingerprint",
    otherAuthorityFingerprint !== admittedFingerprint,
  );

  // Execution keeps the admitted owner: the route bind that execution performs resolves
  // against the SAME snapshot rather than requiring a new one. This is the call that raises
  // "Reply operation has no active tool authority snapshot" when nothing bound at admission.
  let routedFingerprint: string | undefined;
  let routeBindError = "";
  try {
    routedFingerprint = operation.bindToolAuthorityRoute({
      provider: "anthropic",
      model: "claude-proof",
    });
  } catch (error) {
    routeBindError = error instanceof Error ? error.message : String(error);
  }
  ok(
    "execution's route bind resolves against the admitted snapshot",
    typeof routedFingerprint === "string" && /^[0-9a-f]{64}$/.test(routedFingerprint),
    `routeBindError=${routeBindError || "(none)"} routedFingerprint=${String(routedFingerprint)}`,
  );

  // ---------------------------------------------------------------- scenario 2
  console.log("");
  console.log(
    "[2] a same-authority follow-up arriving in that window is ROUTED INTO the steer path",
  );

  const active = isReplyRunActiveForSessionId(SESSION_ID);
  ok("the real registry reports the session active during the window", active);

  const observeQueueItem = async (messageId: string): Promise<AnyRecord | undefined> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const queue = getExistingFollowupQueue(SESSION_KEY) as AnyRecord | undefined;
      const items = (queue?.items ?? []) as AnyRecord[];
      const found = items.find((item) => (item.messageId as string) === messageId);
      if (found) {
        return found;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    return undefined;
  };

  type InboundOutcome = { settled: boolean; error: string };

  /**
   * Reproduces production's admission computation rather than asserting its outputs.
   * `queueAdmissionState` is production's own function over the live queue and live active
   * operation (`get-reply-run-admission.ts:557`); `shouldSteer`/`shouldFollowup` are
   * production's conjunctions (`:562`, `:571`). Every conjunct this fixture holds constant is
   * a property of the fixture: an ordinary CLI user message is not a room event and not a
   * heartbeat, nothing triggers a reset or preempts a heartbeat, no recovery owner is
   * registered, and `resolveActiveRunAcceptsCurrentThread` returns true for any route that is
   * not a Slack direct-routed thread turn (`:474-480`).
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

  const runInbound = async (run: AnyRecord): Promise<InboundOutcome> => {
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
      defaultModel: "claude-proof",
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
    // Failures and timeouts are reported, never swallowed: the caller asserts on `settled`
    // and `error` rather than treating a silent timeout as success.
    await Promise.race([
      settled,
      new Promise((resolve) => {
        setTimeout(resolve, 5_000);
      }),
    ]);
    return outcome;
  };

  const sameAuthorityOutcome = await runInbound(sameAuthorityRun);
  ok(
    "the same-authority inbound turn ran to completion without error",
    sameAuthorityOutcome.settled && sameAuthorityOutcome.error === "",
    `settled=${sameAuthorityOutcome.settled} error=${sameAuthorityOutcome.error || "(none)"}`,
  );
  const sameAuthorityItem = await observeQueueItem("proof-msg-2");
  ok(
    "the same-authority follow-up reached the real follow-up queue",
    sameAuthorityItem !== undefined,
  );
  ok(
    "the same-authority follow-up was ROUTED INTO the steer path for the in-flight turn",
    sameAuthorityItem?.steerAnchor === true,
    "steerAnchor is absent, so production skipped runActiveReplySteer and enqueued the message as its own turn",
  );
  // Bound the claim to what this harness can observe. The steer is parked and then falls
  // back, because the admitted turn is deliberately held pre-execution with no backend
  // attached, so `resolveCurrentMessageInjectionTarget` has nothing to inject into. The
  // harness therefore proves the ROUTING decision this PR changes, not a completed
  // injection; the completed injection needs an executing turn and is out of its scope.
  ok(
    "that steer then falls back here, because the held turn has no injectable backend",
    sameAuthorityItem?.steerPending === undefined,
    `steerPending=${JSON.stringify(sameAuthorityItem?.steerPending ?? null)} — the harness expects fallback and must not report a completed steer`,
  );

  // ---------------------------------------------------------------- scenario 3
  console.log("");
  console.log("[3] discrimination control — a different-authority follow-up is NOT steered");

  const otherAuthorityOutcome = await runInbound(otherAuthorityRun);
  ok(
    "the different-authority inbound turn ran to completion without error",
    otherAuthorityOutcome.settled && otherAuthorityOutcome.error === "",
    `settled=${otherAuthorityOutcome.settled} error=${otherAuthorityOutcome.error || "(none)"}`,
  );
  const otherAuthorityItem = await observeQueueItem("proof-msg-3");
  ok(
    "the different-authority follow-up reached the real follow-up queue",
    otherAuthorityItem !== undefined,
  );
  ok(
    "the different-authority follow-up is enqueued as its own turn, NOT routed into the steer path",
    otherAuthorityItem?.steerAnchor === undefined,
    "steerAnchor is present, so the observation does not discriminate on authority",
  );

  // ---------------------------------------------------------------- scenario 4
  // Runs last: it deliberately attempts a mutation, so it must not perturb the
  // observations above.
  console.log("");
  console.log("[4] the admitted snapshot is immutable for the rest of the turn");

  let replaceRejected = "";
  try {
    operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(otherAuthorityRun as never));
  } catch (error) {
    replaceRejected = error instanceof Error ? error.message : String(error);
  }
  ok(
    "a later bind cannot replace the turn's admitted tool authority",
    replaceRejected.includes("cannot change tool authority after admission"),
    `rejection=${replaceRejected || "(none — a foreign snapshot was accepted onto the admitted turn)"}`,
  );
  ok(
    "the admitted fingerprint survived the replacement attempt",
    operation.toolAuthorityFingerprint === admittedFingerprint,
    `after=${String(operation.toolAuthorityFingerprint)} admitted=${String(admittedFingerprint)}`,
  );

  console.log("");
  if (failures.length > 0) {
    throw new Error(`${failures.length} of ${checks} runtime assertions failed`);
  }
  console.log(`All runtime assertions passed. (${checks} checks)`);
}

main()
  .then(() => {
    rmSync(proofHome, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.log(`PROOF FAILED after ${checks} checks: ${String(error)}`);
    if (failures.length > 0) {
      console.log("Failed assertions:");
      for (const failure of failures) {
        console.log(`  - ${failure}`);
      }
    }
    rmSync(proofHome, { recursive: true, force: true });
    process.exit(1);
  });
