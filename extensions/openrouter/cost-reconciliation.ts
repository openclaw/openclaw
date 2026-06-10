/**
 * OpenRouter post-stream cost reconciliation.
 *
 * The streaming chat-completion response carries a base-tier cost value in the
 * final chunk that the shared OpenAI-compatible parser maps to
 * `message.usage.cost.total`. OpenRouter applies tier-priced billing for some
 * models (notably long-context Qwen tiers) and only exposes the authoritative
 * billed amount through `GET /api/v1/generation?id=<responseId>` after the
 * stream completes. The streamed value can be a substantial undercount of the
 * billed amount on tier-priced calls (4× was reported for #68066).
 *
 * Fetch the authoritative `total_cost` for the just-completed response and
 * overwrite `message.usage.cost.total` in place. Fail open: a missing
 * responseId, missing API key, network failure, malformed payload, or
 * `total_cost` smaller than the streamed estimate is logged at warn-level and
 * the original cost is preserved so a flaky lookup never breaks a turn.
 */
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOpenRouterBaseUrl, OPENROUTER_BASE_URL } from "./provider-catalog.js";

const log = createSubsystemLogger("openrouter-stream");

const DEFAULT_GENERATION_LOOKUP_TIMEOUT_MS = 8_000;

export type FetchLike = typeof fetch;

export type OpenRouterCostReconciliationDeps = {
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
  now?: () => number;
};

type ReconciliationOutcome =
  | { status: "updated"; previousCost: number; updatedCost: number }
  | { status: "skipped"; reason: string };

export async function reconcileOpenRouterUsageCost(params: {
  message: AssistantMessage;
  apiKey: string | undefined;
  deps?: OpenRouterCostReconciliationDeps;
}): Promise<ReconciliationOutcome> {
  const { message, apiKey } = params;
  const responseId = typeof message.responseId === "string" ? message.responseId.trim() : "";
  if (!responseId) {
    return skipped("missing responseId");
  }
  if (!apiKey || apiKey.trim().length === 0) {
    return skipped("missing OpenRouter API key");
  }
  if (message.stopReason === "aborted" || message.stopReason === "error") {
    return skipped(`terminal stopReason ${message.stopReason}`);
  }
  const usage = message.usage;
  if (!usage || !usage.cost || typeof usage.cost.total !== "number") {
    return skipped("missing usage.cost.total");
  }

  const total = await fetchOpenRouterGenerationTotalCost({
    responseId,
    apiKey,
    deps: params.deps,
  });
  if (total === null) {
    return skipped("generation lookup returned no usable total_cost");
  }
  const previousCost = usage.cost.total;
  // Tier-priced billing only ever pushes the authoritative amount upward
  // relative to the base-tier streamed estimate; treat a smaller authoritative
  // value as a stale or partial generation record and keep the streamed cost.
  if (total <= previousCost) {
    return skipped(
      `authoritative total_cost ${total} not greater than streamed cost ${previousCost}`,
    );
  }
  usage.cost.total = total;
  return { status: "updated", previousCost, updatedCost: total };
}

async function fetchOpenRouterGenerationTotalCost(params: {
  responseId: string;
  apiKey: string;
  deps?: OpenRouterCostReconciliationDeps;
}): Promise<number | null> {
  const baseUrl = (params.deps?.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, "");
  const url = `${baseUrl}/generation?id=${encodeURIComponent(params.responseId)}`;
  const fetchImpl = params.deps?.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    log.warn("openrouter cost reconciliation skipped: fetch is unavailable");
    return null;
  }
  const timeoutMs = params.deps?.timeoutMs ?? DEFAULT_GENERATION_LOOKUP_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${params.apiKey}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      log.warn(
        `openrouter cost reconciliation skipped: HTTP ${response.status} from /generation?id=${params.responseId}`,
      );
      return null;
    }
    const payload = (await response.json()) as unknown;
    return extractTotalCost(payload);
  } catch (error) {
    log.warn(`openrouter cost reconciliation skipped: ${String(error)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractTotalCost(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const candidate =
    "data" in (payload as Record<string, unknown>) &&
    typeof (payload as { data?: unknown }).data === "object"
      ? (payload as { data: Record<string, unknown> }).data
      : (payload as Record<string, unknown>);
  const total = candidate.total_cost;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
    return null;
  }
  return total;
}

function skipped(reason: string): ReconciliationOutcome {
  return { status: "skipped", reason };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function shouldReconcileOpenRouterGenerationCost(model: Parameters<StreamFn>[0]): boolean {
  const baseUrl = readString(model.baseUrl);
  if (baseUrl) {
    return normalizeOpenRouterBaseUrl(baseUrl) === OPENROUTER_BASE_URL;
  }
  return readString(model.provider)?.toLowerCase() === "openrouter";
}

/**
 * Wrap a base StreamFn so the final assistant message carries OpenRouter's
 * authoritative billed total_cost when the lookup succeeds. The wrapper is
 * transparent for the consumer: events flow through unchanged and the "done"
 * event's `message` reference is mutated in place before being forwarded so
 * both the streamed iteration and `result()` paths observe the reconciled
 * cost. All failure modes degrade to a warn log and the original streamed
 * cost so a flaky reconciliation never breaks a turn.
 */
export function createOpenRouterCostReconciliationWrapper(
  baseStreamFn: StreamFn | undefined,
  deps?: OpenRouterCostReconciliationDeps,
): StreamFn | undefined {
  if (!baseStreamFn) {
    return baseStreamFn;
  }
  const wrapped: StreamFn = (model, context, options) => {
    const baseStreamResult = baseStreamFn(model, context, options);
    if (!shouldReconcileOpenRouterGenerationCost(model)) {
      return baseStreamResult;
    }
    const apiKey = options?.apiKey;
    return wrapStreamWithReconciliation({
      baseStreamPromise: Promise.resolve(baseStreamResult),
      apiKey,
      deps,
    });
  };
  return wrapped;
}

type AssistantMessageEventStreamLike = Awaited<ReturnType<StreamFn>>;
type AssistantMessageEventLike =
  AssistantMessageEventStreamLike extends AsyncIterable<infer T> ? T : never;

function wrapStreamWithReconciliation(params: {
  baseStreamPromise: Promise<AssistantMessageEventStreamLike>;
  apiKey: string | undefined;
  deps?: OpenRouterCostReconciliationDeps;
}): AssistantMessageEventStreamLike {
  const baseStreamPromise = params.baseStreamPromise;
  // Lazy-defer base-stream side effects until iteration begins so the consumer
  // sees identical timing to the unwrapped stream up through the "done" event.
  let baseStreamFinalResult: Promise<AssistantMessage> | null = null;
  const reconciledMessages = new WeakSet<AssistantMessage>();
  const activeReconciliations = new WeakMap<AssistantMessage, Promise<void>>();

  async function reconcileMessageOnce(message: AssistantMessage): Promise<void> {
    if (reconciledMessages.has(message)) {
      return;
    }
    const active = activeReconciliations.get(message);
    if (active) {
      await active;
      return;
    }
    const reconciliation = (async () => {
      const outcome = await reconcileOpenRouterUsageCost({
        message,
        apiKey: params.apiKey,
        deps: params.deps,
      });
      if (outcome.status === "updated") {
        log.info(
          `openrouter cost reconciled: ${outcome.previousCost} -> ${outcome.updatedCost} (responseId=${message.responseId})`,
        );
      }
      reconciledMessages.add(message);
    })();
    activeReconciliations.set(message, reconciliation);
    try {
      await reconciliation;
    } finally {
      activeReconciliations.delete(message);
    }
  }

  const iterate = async function* (): AsyncGenerator<AssistantMessageEventLike> {
    const baseStream = await baseStreamPromise;
    baseStreamFinalResult = baseStream.result();
    for await (const event of baseStream as AsyncIterable<AssistantMessageEventLike>) {
      const maybeDone = event as { type?: string; message?: AssistantMessage };
      if (
        maybeDone &&
        maybeDone.type === "done" &&
        maybeDone.message &&
        typeof maybeDone.message === "object"
      ) {
        await reconcileMessageOnce(maybeDone.message);
      }
      yield event;
    }
  };

  const iterable: AssistantMessageEventStreamLike = {
    [Symbol.asyncIterator]: () => iterate(),
    async result() {
      if (!baseStreamFinalResult) {
        const baseStream = await baseStreamPromise;
        baseStreamFinalResult = baseStream.result();
      }
      const message = await baseStreamFinalResult;
      await reconcileMessageOnce(message);
      return message;
    },
  } as AssistantMessageEventStreamLike;

  return iterable;
}
