import type {
  DecisionAnswerV2,
  DecisionBatchV2,
  DecisionEntry,
  DecisionProviderContextV2,
} from "openclaw/plugin-sdk/decisions";

type DecisionCapabilities = NonNullable<
  NonNullable<DecisionProviderContextV2["model"]["inference"]>["decision"]
>;

/** Declared for configured rerank rows that do not author their own Decision facts. */
export const RERANK_DECISION_CAPABILITIES = {
  protocol: "rerank",
  input: ["text"],
  questions: {
    boolean: { probabilities: "boolean", abstention: false },
    choice: { probabilities: "independent", abstention: false, minOptions: 2 },
    sort: { probabilities: "none", abstention: false, minOptions: 1 },
  },
  confidence: "none",
} satisfies DecisionCapabilities;

/** One `/rerank` call: a query scored against documents. */
export type RerankRequest = { readonly query: string; readonly documents: readonly string[] };

/** Where each scored document lands in the Decision answers. */
type Slot =
  | { readonly kind: "boolean"; readonly question: string; readonly request: number }
  | {
      readonly kind: "choice";
      readonly question: string;
      readonly label: string;
      readonly request: number;
    }
  | {
      readonly kind: "sort";
      readonly question: string;
      readonly id: string;
      readonly request: number;
    };

export type RerankPlan = {
  readonly requests: readonly RerankRequest[];
  /** Slots per request, index-aligned with that request's documents. */
  readonly slots: readonly (readonly Slot[])[];
};

function render(value: DecisionEntry): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function stateQuery(batch: DecisionBatchV2): string | undefined {
  const { state } = batch;
  if (state.type === "text") {
    return state.text;
  }
  if (state.type === "json") {
    return render(state.value as DecisionEntry);
  }
  return undefined;
}

/**
 * Map Decision questions onto rerank calls. A reranker answers "how relevant is
 * this document to this query", so:
 * - boolean: query = state, document = instructions (or the `true` criterion);
 *   P(true) is the relevance score.
 * - choice: query = state, one document per option (its description, or the
 *   label); the highest-scoring option wins, scores are independent.
 * - sort: query = instructions, documents = the list items, ordered by score.
 * Score, tags, box, and image state are unsupported. Returns undefined when
 * any question cannot be answered.
 */
export function planRerankDecision(batch: DecisionBatchV2): RerankPlan | undefined {
  const requests: { query: string; documents: string[] }[] = [];
  const slots: Slot[][] = [];
  const requestFor = (query: string) => {
    let index = requests.findIndex((request) => request.query === query);
    if (index < 0) {
      index = requests.push({ query, documents: [] }) - 1;
      slots.push([]);
    }
    return index;
  };
  const add = (request: number, document: string, slot: Slot) => {
    requests[request]!.documents.push(document);
    slots[request]!.push(slot);
  };
  const query = stateQuery(batch);
  for (const [question, spec] of Object.entries(batch.questions)) {
    if (spec.type === "boolean") {
      const document = spec.instructions ?? spec.criteria?.true ?? null;
      if (query === undefined || !query.trim() || document === null) {
        return undefined;
      }
      const request = requestFor(query);
      add(request, render(document), { kind: "boolean", question, request });
      continue;
    }
    if (spec.type === "choice") {
      const labels = Object.keys(spec.criteria);
      if (query === undefined || !query.trim() || labels.length < 2) {
        return undefined;
      }
      const request = requestFor(query);
      for (const label of labels) {
        const description = spec.criteria[label];
        add(request, description == null ? label : render(description), {
          kind: "choice",
          question,
          label,
          request,
        });
      }
      continue;
    }
    if (spec.type === "sort") {
      if (batch.state.type !== "list" || spec.instructions == null) {
        return undefined;
      }
      const sortQuery = render(spec.instructions);
      if (!sortQuery.trim() || batch.state.items.length === 0) {
        return undefined;
      }
      const request = requestFor(sortQuery);
      for (const item of batch.state.items) {
        add(request, render(item.content), { kind: "sort", question, id: item.id, request });
      }
      continue;
    }
    return undefined;
  }
  if (requests.length === 0 || requests.some((request) => request.documents.length === 0)) {
    return undefined;
  }
  return { requests, slots };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Read one `/rerank` response into scores aligned with the request's documents.
 * Accepts the Cohere-style `{ results: [{ index, relevance_score }] }` used by
 * Cohere, Jina, vLLM, Infinity and llama.cpp, Voyage's `{ data: [...] }`, and
 * TEI's bare `[{ index, score }]` array. Every document must be scored once.
 */
export function readRerankScores(payload: unknown, count: number): number[] | undefined {
  const container = payload as { results?: unknown; data?: unknown } | null;
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(container?.results)
      ? container.results
      : Array.isArray(container?.data)
        ? container.data
        : undefined;
  if (!rows || rows.length !== count) {
    return undefined;
  }
  const scores: (number | undefined)[] = Array.from({ length: count });
  for (const row of rows as unknown[]) {
    const entry = row as { index?: unknown; relevance_score?: unknown; score?: unknown } | null;
    const index = entry?.index;
    const score = finiteNumber(entry?.relevance_score) ?? finiteNumber(entry?.score);
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= count ||
      scores[index] !== undefined ||
      score === undefined
    ) {
      return undefined;
    }
    scores[index] = score;
  }
  const complete = scores as number[];
  // Most servers already return [0, 1] relevance. Raw logits (any value
  // outside that range) go through the sigmoid every cross-encoder uses.
  return complete.every((score) => score >= 0 && score <= 1)
    ? complete
    : complete.map((score) => 1 / (1 + Math.exp(-score)));
}

/** Assemble Decision answers from per-request scores. */
export function decodeRerankDecision(
  plan: RerankPlan,
  scores: readonly (readonly number[])[],
): Record<string, DecisionAnswerV2> {
  const answers: Record<string, DecisionAnswerV2> = {};
  const choices = new Map<string, Record<string, number>>();
  const sorts = new Map<string, { id: string; score: number; position: number }[]>();
  plan.slots.forEach((requestSlots, request) => {
    requestSlots.forEach((slot, position) => {
      const score = scores[request]![position]!;
      if (slot.kind === "boolean") {
        answers[slot.question] = { type: "boolean", probabilityTrue: score };
      } else if (slot.kind === "choice") {
        const probabilities = choices.get(slot.question) ?? {};
        probabilities[slot.label] = score;
        choices.set(slot.question, probabilities);
      } else {
        const ranked = sorts.get(slot.question) ?? [];
        ranked.push({ id: slot.id, score, position });
        sorts.set(slot.question, ranked);
      }
    });
  });
  for (const [question, probabilities] of choices) {
    let choice: string | null = null;
    for (const [label, score] of Object.entries(probabilities)) {
      if (choice === null || score > probabilities[choice]!) {
        choice = label;
      }
    }
    answers[question] = { type: "choice", choice, probabilities };
  }
  for (const [question, ranked] of sorts) {
    answers[question] = {
      type: "sort",
      order: ranked
        .toSorted((a, b) => b.score - a.score || a.position - b.position)
        .map(({ id }) => id),
    };
  }
  return answers;
}
