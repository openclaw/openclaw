// Superfast Decision Gate — System One front-door classifier.
//
// A small, non-autoregressive "System One" decision server evaluates the pending
// user turn in a single forward pass and returns typed, calibrated answers
// (choice / noul / score) without generating text. The gate turns those answers
// into a routing recommendation so a caller could skip expensive System Two work
// when the decision is obvious.
//
// Design contract:
//   - Fail-open. Any error, timeout, non-2xx, or schema miss returns `null`.
//     Callers MUST treat `null` as "no opinion" and continue exactly as they
//     would with the gate disabled. The gate can only ever make the caller faster,
//     never change behaviour when it is unsure.
//   - No new runtime dependencies. The gate talks to a local HTTP endpoint
//     (`/v1/systemone`) with plain `fetch`, so the fork does not bundle the
//     decision model. The model is installed out-of-band.
//   - Off by default. Nothing here runs unless `enabled` is true.

/** Wire-level question kinds supported by the System One protocol. */
export type QuestionSpec =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

/** A single answer returned by the decision model. */
export interface DecisionAnswer {
  /** For `choice`: the selected criterion key. */
  choice?: string;
  /** For `noul`: probability the statement is true, in [0, 1]. */
  noul?: number;
  /** For `score`: expected value across the ordered levels. */
  score?: number;
  /** Calibrated confidence for choice / score answers. */
  confidence?: number;
  /** Full probability distribution for choice answers. */
  probabilities?: Record<string, number>;
}

/** Raw response envelope from `/v1/systemone`. */
interface SystemOneResponse {
  answers?: Record<string, DecisionAnswer>;
}

/** Runtime configuration for the gate, resolved from settings. */
export interface DecisionGateSettings {
  /** Master switch. When false the gate is never invoked. */
  enabled: boolean;
  /** Full URL of the decision endpoint, e.g. http://localhost:8000/v1/systemone */
  endpoint: string;
  /** Model id sent in the request body, e.g. von-1.2.0 */
  model: string;
  /** Hard timeout for a single decision call, in milliseconds. */
  timeoutMs: number;
}

export const DEFAULT_GATE_SETTINGS: DecisionGateSettings = {
  enabled: false,
  endpoint: "http://localhost:8000/v1/systemone",
  model: "von-1.2.0",
  timeoutMs: 150,
};

/** Partial settings as read from plugin config (all fields optional). */
export interface SuperfastSettingsInput {
  enabled?: boolean;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
}

/** Merge a partial settings object over the defaults into a full config. */
export function resolveGateSettings(input?: SuperfastSettingsInput | null): DecisionGateSettings {
  return {
    enabled: input?.enabled ?? DEFAULT_GATE_SETTINGS.enabled,
    endpoint: input?.endpoint || DEFAULT_GATE_SETTINGS.endpoint,
    model: input?.model || DEFAULT_GATE_SETTINGS.model,
    timeoutMs:
      typeof input?.timeoutMs === "number" && input.timeoutMs > 0
        ? input.timeoutMs
        : DEFAULT_GATE_SETTINGS.timeoutMs,
  };
}

/**
 * Issue one System One request. Returns the parsed answers on success, or
 * `null` on any failure (fail-open). Never throws except when the caller's own
 * `signal` is aborted, which propagates as an AbortError.
 */
export async function querySystemOne(
  state: string,
  questions: Record<string, QuestionSpec>,
  settings: DecisionGateSettings,
  signal?: AbortSignal,
): Promise<Record<string, DecisionAnswer> | null> {
  const timeoutSignal = AbortSignal.timeout(settings.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  try {
    const res = await fetch(settings.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.model,
        state,
        questions,
      }),
      signal: combined,
    });

    if (!res.ok) {
      return null;
    }

    const json = (await res.json()) as SystemOneResponse;
    if (!json || typeof json.answers !== "object" || json.answers === null) {
      return null;
    }

    return json.answers;
  } catch (err) {
    // The caller's own abort must propagate; everything else fails open.
    if (signal?.aborted) {
      throw err;
    }
    return null;
  }
}

/** The routing recommendation derived from a turn's decision answers. */
export type TurnRoute = "needs_tool" | "answer_from_context" | "plain_chat" | "unknown";

/** A turn-level decision: the raw answers plus a derived route. */
export interface TurnDecision {
  route: TurnRoute;
  answers: Record<string, DecisionAnswer>;
  latencyMs: number;
}

/**
 * Standard question set for classifying an incoming user turn. Kept small so the
 * single forward pass stays well under the timeout budget.
 */
const TURN_QUESTIONS: Record<string, QuestionSpec> = {
  needs_tool: {
    type: "noul",
    instructions:
      "Does answering this request require taking an action with a tool (reading, writing, running, searching), rather than replying from what is already known?",
  },
  answerable_from_context: {
    type: "noul",
    instructions:
      "Can this request be answered from information already present in the conversation, without any new investigation?",
  },
  intent: {
    type: "choice",
    instructions: "Classify the primary intent of the user request.",
    criteria: {
      code_change: "Create, edit, or delete code or files.",
      code_question: "Explain or reason about code without changing it.",
      command: "Run a command or operation.",
      chat: "Casual conversation or a question needing no tools.",
      other: "None of the above.",
    },
  },
};

/**
 * Classify a user turn through the gate. Returns `null` when the gate is disabled
 * or unavailable (fail-open). Otherwise returns a TurnDecision whose `route` is a
 * conservative recommendation the caller may act on.
 */
export async function classifyTurn(
  userMessage: string,
  settings: DecisionGateSettings,
  signal?: AbortSignal,
): Promise<TurnDecision | null> {
  if (!settings.enabled) {
    return null;
  }

  const startedAt = Date.now();
  const answers = await querySystemOne(userMessage, TURN_QUESTIONS, settings, signal);
  if (!answers) {
    return null;
  }

  return {
    route: deriveRoute(answers),
    answers,
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * Derive a conservative route from the answers. The gate only recommends a fast
 * route when the relevant probabilities are decisive; otherwise it says `unknown`
 * so the caller falls back to the normal path.
 */
function deriveRoute(answers: Record<string, DecisionAnswer>): TurnRoute {
  const needsTool = answers["needs_tool"]?.noul;
  const fromContext = answers["answerable_from_context"]?.noul;

  // Decisive "needs a tool" wins first — the caller must not skip work.
  if (typeof needsTool === "number" && needsTool >= 0.85) {
    return "needs_tool";
  }

  // Strongly answerable from context and low tool need → answer from context.
  if (
    typeof fromContext === "number" &&
    fromContext >= 0.85 &&
    (needsTool === undefined || needsTool <= 0.3)
  ) {
    return "answer_from_context";
  }

  // Clearly chat with no tool need.
  if (answers["intent"]?.choice === "chat" && (needsTool === undefined || needsTool <= 0.2)) {
    return "plain_chat";
  }

  return "unknown";
}

/**
 * Lightweight health probe used by `/superfast status`. Returns true only if the
 * endpoint answers a trivial noul question within the timeout.
 */
export async function probeBackend(settings: DecisionGateSettings): Promise<boolean> {
  const answers = await querySystemOne(
    "health check",
    { ok: { type: "noul", instructions: "Is the service healthy?" } },
    settings,
  );
  return answers !== null && typeof answers["ok"]?.noul === "number";
}
