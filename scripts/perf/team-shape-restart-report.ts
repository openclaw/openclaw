// Analyze captured public RPC evidence without treating consumed input as an answer.
export type StressInput = {
  id: string;
  sessionKey: string;
  sentAt: number;
  accepted: boolean;
  rejected?: boolean;
  phase: string;
  ack?: unknown;
  error?: string;
};
export type StressEvent = { at: number; event: string; payload?: unknown };
export type RestartRecord = {
  kind: string;
  at: number;
  returnedAt?: number;
  active: string[];
  idle: string[];
  exitCode?: number | null;
  signal?: string | null;
  shutdownMs?: number;
  error?: string;
};
export type StressSettlement = {
  startedAt: number;
  deadline: number;
  finishedAt?: number;
  timedOut: boolean;
};
export type SharedRateLimitProbe = {
  first429At: number;
  resetAt: number;
  newcomerCreatedAt?: number;
};
type Status = "pass" | "fail" | "unknown";
type Invariant = { id: number; name: string; status: Status; details: string; evidence: unknown[] };
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
function text(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(text).join("\n");
  }
  const item = record(value);
  return typeof item.text === "string"
    ? item.text
    : item.content !== undefined
      ? text(item.content)
      : "";
}
export function stressAnswerMessages(history: unknown, inputId: string) {
  return array(record(history).messages)
    .map(record)
    .filter(
      (message) =>
        message.role === "assistant" &&
        (message.phase === undefined || message.phase === "final_answer") &&
        text(message.content).trimEnd().split(/\r?\n/).at(-1) === `DONE_${inputId}`,
    );
}
function percentile(values: number[], fraction: number) {
  return values.length ? values[Math.max(0, Math.ceil(values.length * fraction) - 1)]! : null;
}

export function summarizeRestartStress(params: {
  inputs: StressInput[];
  events: StressEvent[];
  restarts: RestartRecord[];
  histories: Record<string, unknown>;
  log: string;
  effects: Record<string, string[]>;
  provider: unknown;
  errors: string[];
  settlement?: StressSettlement;
  sharedRateLimit?: SharedRateLimitProbe;
}) {
  const histories = Object.fromEntries(
    Object.entries(params.histories).map(([key, value]) => [key, record(value)]),
  );
  const events = params.events.map((event) => ({ ...event, payload: record(event.payload) }));
  const firstActivity = record(record(params.provider).firstActivity);
  const messages = (key: string) => array(histories[key]?.messages).map(record);
  const rows = params.inputs.map((input) => {
    const runId = record(input.ack).runId ?? input.id;
    const matching = events.filter(
      (event) => event.payload.runId === runId && event.at >= input.sentAt,
    );
    const finalMessages = new Map<string | number, Record<string, unknown>>();
    for (const [index, message] of stressAnswerMessages(
      histories[input.sessionKey],
      input.id,
    ).entries()) {
      const id = record(message["__openclaw"]).id;
      finalMessages.set(typeof id === "string" ? id : index, message);
    }
    const finals = Array.from(finalMessages, ([messageId, message]) => ({
      messageId,
      at: record(message["__openclaw"]).recordTimestampMs,
    }));
    const terminal = matching.find(
      (event) =>
        event.event === "chat" && ["error", "aborted"].includes(String(event.payload.state)),
    );
    const answered = matching.find(
      (event) =>
        event.event === "chat" &&
        event.payload.state === "final" &&
        event.payload.yielded !== true &&
        text(event.payload.message) &&
        !text(event.payload.message).includes("Your message is queued for a new turn"),
    );
    const receipt = array(histories[input.sessionKey]?.inputReceipts)
      .map(record)
      .find((item) => item.runId === input.id || item.runId === runId);
    const pending = array(record(histories[input.sessionKey]?.pendingInputs).items)
      .map(record)
      .filter((item) => item.runId === input.id || item.runId === runId);
    const accepted =
      input.accepted ||
      Boolean(receipt) ||
      pending.length > 0 ||
      finals.length > 0 ||
      Boolean(answered || terminal);
    const activity = matching.find(
      (event) =>
        (event.event === "agent" &&
          ["assistant", "thinking", "tool"].includes(String(event.payload.stream))) ||
        (event.event === "chat" && event.payload.state === "delta"),
    );
    const requestAt = firstActivity[input.id];
    const activityAt =
      typeof requestAt === "number" && requestAt >= input.sentAt ? requestAt : activity?.at;
    return {
      ...input,
      accepted,
      acknowledged: input.accepted,
      acceptanceSource: input.accepted
        ? "ack"
        : receipt
          ? "durable-receipt"
          : pending.length
            ? "pending-input"
            : finals.length || answered || terminal
              ? "terminal-evidence"
              : input.rejected
                ? "rpc-rejection"
                : "unknown",
      transportUncertain: !input.accepted && !input.rejected,
      runId,
      outcome: !accepted
        ? input.rejected
          ? "rejected"
          : "acceptance-unknown"
        : finals.length || answered
          ? "answered"
          : terminal?.payload.state === "error"
            ? "failed"
            : terminal?.payload.state === "aborted" || receipt?.cancelled === true
              ? "cancelled"
              : params.settlement?.timedOut
                ? "timed-out"
                : "unresolved",
      finalMarkers: finals.length,
      finalReceipts: finals,
      receipt,
      pending,
      sessionInfo: histories[input.sessionKey]?.sessionInfo,
      terminal,
      firstActivityAt: activityAt,
      latencyMs: activityAt === undefined ? null : activityAt - input.sentAt,
    };
  });
  const accepted = rows.filter((input) => input.accepted);
  const acceptanceUnknown = rows.filter((input) => input.outcome === "acceptance-unknown");
  const unresolved = accepted.filter((input) =>
    ["unresolved", "timed-out"].includes(input.outcome),
  );
  const stuckQueued = accepted.filter(
    (input) =>
      record(input.sessionInfo).hasActiveRun === false &&
      (input.pending.some((item) => item.state === "queued" || item.queued === true) ||
        (input.receipt?.state === "pending" &&
          input.receipt.queued === true &&
          input.receipt.cancelled !== true)),
  );
  const duplicateFinals = rows.filter((input) => input.finalMarkers > 1);
  const effects = Object.entries(params.effects).flatMap(([file, lines]) => {
    const counts = new Map<string, number>();
    for (const line of lines) {
      if (line.startsWith("EFFECT_")) {
        counts.set(line, (counts.get(line) ?? 0) + 1);
      }
    }
    return [...counts].map(([effect, count]) => ({ file, effect, count }));
  });
  const duplicateEffects = effects.filter((effect) => effect.count > 1);
  const graceful = params.restarts.filter((restart) => restart.kind.toUpperCase() !== "SIGKILL");
  const recovery = graceful.flatMap((restart) => {
    const end = params.restarts.find((candidate) => candidate.at > restart.at)?.at ?? Infinity;
    const exitedAt = restart.shutdownMs === undefined ? undefined : restart.at + restart.shutdownMs;
    return [...restart.active, ...restart.idle].map((sessionKey) => {
      const newInput = params.inputs.some(
        (input) =>
          input.sessionKey === sessionKey && input.sentAt >= restart.at && input.sentAt < end,
      );
      const starts = events.filter(
        (event) =>
          event.at >= (exitedAt ?? Infinity) &&
          event.at < end &&
          event.event === "agent" &&
          event.payload.sessionKey === sessionKey &&
          event.payload.stream === "lifecycle" &&
          record(event.payload.data).phase === "start",
      );
      const active = restart.active.includes(sessionKey);
      const idleMessages = active
        ? []
        : messages(sessionKey).flatMap((message) => {
            const at = record(message["__openclaw"]).recordTimestampMs;
            return typeof at === "number" && exitedAt !== undefined && at > exitedAt && at < end
              ? [{ at, role: message.role, id: record(message["__openclaw"]).id }]
              : [];
          });
      const expected = rows.filter(
        (input) => input.accepted && input.sessionKey === sessionKey && input.sentAt < restart.at,
      );
      const completions = expected.map((input) => ({
        inputId: input.id,
        finals: input.finalReceipts.filter(
          (final) =>
            typeof final.at === "number" &&
            exitedAt !== undefined &&
            final.at > exitedAt &&
            final.at < end,
        ),
        effects: effects.filter((effect) => effect.effect === `EFFECT_${input.id}`),
      }));
      const completed =
        completions.length > 0 && completions.every((input) => input.finals.length > 0);
      const duplicate = completions.some(
        (input) => input.finals.length > 1 || input.effects.some((effect) => effect.count > 1),
      );
      const once = completed && !duplicate && expected.every((input) => input.finalMarkers === 1);
      return {
        kind: restart.kind,
        at: restart.at,
        sessionKey,
        active,
        newInput,
        completed,
        exitedAt,
        completions,
        starts: starts.map((event) => ({ at: event.at, runId: event.payload.runId })),
        idleMessages,
        status:
          newInput || !restart.returnedAt
            ? "unknown"
            : active
              ? duplicate
                ? "fail"
                : once
                  ? "pass"
                  : "unknown"
              : starts.length || idleMessages.length
                ? "fail"
                : "unknown", // Disconnected silence does not prove idle inactivity.
      };
    });
  });
  const recoveredKeys = new Set(
    recovery
      .filter((item) => item.active && item.completed && !item.newInput)
      .map((item) => item.sessionKey),
  );
  const noise: unknown[] = [];
  for (const sessionKey of recoveredKeys) {
    for (const message of messages(sessionKey)) {
      const kind = record(message["__openclaw"]).kind;
      if (
        (message.role === "system" && !["compaction", "reset"].includes(String(kind))) ||
        message.stopReason === "error" ||
        kind === "error"
      ) {
        noise.push({ sessionKey, message });
      }
    }
    for (const event of events) {
      if (
        event.event === "chat" &&
        event.payload.sessionKey === sessionKey &&
        event.payload.state === "error"
      ) {
        noise.push({ sessionKey, event });
      }
    }
  }
  const lines = params.log.split("\n");
  const logEvidence = (pattern: RegExp) =>
    lines.flatMap((line, index) => (pattern.test(line) ? [{ line: index + 1, text: line }] : []));
  const crashes = logEvidence(
    /unhandled(?: promise)? rejection|uncaught(?: exception)?|UnhandledPromiseRejection/i,
  );
  const unexpectedExits = events.filter(
    (event) =>
      event.event === "process.exit" &&
      !params.restarts.some(
        (restart) =>
          event.at >= restart.at &&
          event.at <= (restart.returnedAt ?? restart.at + (restart.shutdownMs ?? 0)),
      ),
  );
  const counts = {
    stuckQueued: stuckQueued.length,
    log429: logEvidence(/\b429\b|Rate limit reached for/).length,
    sameModelRetries: logEvidence(/transient same-model retry/).length,
    fallbackDecisions: logEvidence(
      /model fallback decision|model_fallback_decision|fallbackStepFinalOutcome/,
    ).length,
    appendOnlyWarnings: logEvidence(/\[prompt-cache\].*history must be append-only/).length,
    provider: params.provider,
  };
  const providerRequests = record(params.provider).requests;
  const newcomer = rows.find((input) => input.id === "rate-newcomer");
  const newcomerRequests = array(providerRequests)
    .map(record)
    .filter((request) => request.id === newcomer?.id && request.streaming === true)
    .toSorted((a, b) => Number(a.at) - Number(b.at));
  const firstNewcomerRequest = newcomerRequests[0];
  const newcomerWaits = events.filter(
    (event) =>
      event.event === "agent" &&
      event.payload.runId === newcomer?.runId &&
      event.payload.stream === "run_status" &&
      record(event.payload.data).reason === "rate_limit" &&
      event.at < (params.sharedRateLimit?.resetAt ?? -Infinity) &&
      Number(record(event.payload.data).retryAt) >= (params.sharedRateLimit?.resetAt ?? Infinity) &&
      event.at < Number(firstNewcomerRequest?.at),
  );
  const probe = params.sharedRateLimit;
  const sharedKnowledge = {
    ...probe,
    input: newcomer,
    firstRequest: firstNewcomerRequest,
    requests: newcomerRequests,
    waits: newcomerWaits,
  };
  const observedRequests =
    typeof providerRequests === "number" ? providerRequests : array(providerRequests).length;
  const latencies = accepted
    .flatMap((input) => (input.latencyMs === null ? [] : [input.latencyMs]))
    .toSorted((a, b) => a - b);
  const latencyMs = {
    samples: latencies.length,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    max: latencies.at(-1) ?? null,
    unresolved: accepted.length - latencies.length,
    source:
      "first provider request by exact input marker, otherwise first matching output/tool event; status-only waits excluded",
  };
  const invariants: Invariant[] = [
    {
      id: 1,
      name: "Every accepted input settles",
      status:
        params.settlement?.timedOut || unresolved.length || stuckQueued.length
          ? "fail"
          : !accepted.length || acceptanceUnknown.length
            ? "unknown"
            : "pass",
      details: `${accepted.length} accepted; ${unresolved.length} unresolved (${unresolved.filter((input) => input.outcome === "timed-out").length} explicitly timed out); ${stuckQueued.length} queued on idle sessions; ${acceptanceUnknown.length} acceptance unknown after transport failure. Consumed receipts alone never count as answered.`,
      evidence: [{ unresolved, stuckQueued, acceptanceUnknown }],
    },
    {
      id: 2,
      name: "Graceful recovery once; idle stays idle",
      status: recovery.some((item) => item.status === "fail")
        ? "fail"
        : !recovery.some((item) => item.active) ||
            recovery.some((item) => item.status === "unknown")
          ? "unknown"
          : "pass",
      details:
        "Unique durable completion after old-process exit and no new input proves outcome recovery. Idle activity checks include durable rows before reconnect; disconnected silence remains inconclusive. Provider attempt count is not asserted.",
      evidence: recovery,
    },
    {
      id: 3,
      name: "No duplicate sentinel effects or final delivery",
      status:
        duplicateEffects.length || duplicateFinals.length
          ? "fail"
          : !effects.length || !rows.some((input) => input.finalMarkers)
            ? "unknown"
            : "pass",
      details:
        "Covers synthetic EFFECT_ and DONE_ markers; arbitrary tool effects are outside this evidence.",
      evidence: [...duplicateEffects, ...duplicateFinals],
    },
    {
      id: 4,
      name: "Recovered work has no visible error/system rows",
      status: noise.length ? "fail" : !recoveredKeys.size ? "unknown" : "pass",
      details:
        "Checks projected system/error rows for recovered sessions that subsequently answered.",
      evidence: noise,
    },
    {
      id: 5,
      name: "Graceful shutdown exits zero without escalation",
      status: !graceful.length
        ? "unknown"
        : graceful.some(
              (restart) => restart.error || restart.exitCode !== 0 || restart.signal !== null,
            )
          ? "fail"
          : "pass",
      details:
        "Requested SIGKILL chaos is excluded from the graceful-exit requirement; shutdown durations are retained.",
      evidence: params.restarts,
    },
    {
      id: 6,
      name: "No unhandled rejection or unexpected crash",
      status:
        crashes.length || unexpectedExits.length || params.errors.length
          ? "fail"
          : params.log
            ? "pass"
            : "unknown",
      details:
        "Controller errors and log signatures are retained; graceful nonzero exits also fail invariant 5.",
      evidence: [...crashes, ...unexpectedExits, ...params.errors],
    },
    {
      id: 7,
      name: "429, retry, fallback, append-only counts",
      status: params.log && observedRequests > 0 ? "pass" : "unknown",
      details: "Diagnostic counts, not an assertion that retries or fallbacks succeeded.",
      evidence: [counts],
    },
    {
      id: 8,
      name: "Input latency coverage",
      status: latencies.length && latencies.length === accepted.length ? "pass" : "unknown",
      details:
        "Missing activity stays explicit and is excluded from percentiles, never treated as zero latency.",
      evidence: [latencyMs],
    },
    {
      id: 9,
      name: "New session uses shared primary rate-limit knowledge",
      status:
        !probe ||
        !newcomer ||
        newcomer.sentAt <= probe.first429At ||
        (probe.newcomerCreatedAt !== undefined && probe.newcomerCreatedAt >= probe.resetAt) ||
        !firstNewcomerRequest
          ? "unknown"
          : firstNewcomerRequest.primary === false ||
              (firstNewcomerRequest.primary === true &&
                Number(firstNewcomerRequest.at) >= probe.resetAt &&
                newcomerWaits.length > 0)
            ? "pass"
            : Number(firstNewcomerRequest.at) < probe.resetAt
              ? "fail"
              : "unknown",
      details:
        "A fresh session is created after the first injected primary 429. Its first streamed request must use fallback or have a recorded shared rate-limit wait until reset; preparation delays alone prove nothing. Title/utility requests are excluded.",
      evidence: [sharedKnowledge],
    },
  ];
  const report = {
    invariants,
    inputs: rows,
    latencyMs,
    counts,
    effects,
    settlement: params.settlement,
    sharedKnowledge,
    errors: params.errors,
  };
  const markdown = [
    "# Isolated Gateway restart stress",
    "",
    ...invariants.map(
      (item) => `- **${item.id}. ${item.name}: ${item.status.toUpperCase()}** — ${item.details}`,
    ),
    "",
    `Latency (ms): p50=${latencyMs.p50 ?? "unknown"}, p95=${latencyMs.p95 ?? "unknown"}, max=${latencyMs.max ?? "unknown"}; ${latencyMs.samples}/${accepted.length} accepted inputs observed.`,
    "",
    "Concrete receipts, timestamps, sessions, restart outcomes, and numbered log evidence are in report.json.",
    "",
  ].join("\n");
  return { report, markdown };
}
