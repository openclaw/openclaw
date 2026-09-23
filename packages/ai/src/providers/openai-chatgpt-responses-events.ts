import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  responsesRequestLifecycle,
  withResponsesRequestAcceptance,
} from "../transports/openai-responses-request-lifecycle.js";
import { createResponseModelTracker } from "../transports/openai-transport-shared.js";
import type { StreamOptions } from "../types.js";

type CodexResponseStatus =
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled"
  | "queued"
  | "in_progress";

export class CodexApiError extends Error {
  readonly code?: string;
  readonly status?: number;
  readonly payload?: Record<string, unknown>;

  constructor(
    message: string,
    options?: {
      code?: string;
      status?: number;
      payload?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "CodexApiError";
    this.code = options?.code;
    this.status = options?.status;
    this.payload = options?.payload;
    this.cause = options?.cause;
  }
}

function extractCodexEventError(event: Record<string, unknown>): {
  code?: string;
  message?: string;
} {
  const nested = isRecord(event.error) ? event.error : undefined;
  return {
    code:
      typeof event.code === "string"
        ? event.code
        : typeof nested?.code === "string"
          ? nested.code
          : undefined,
    message:
      typeof event.message === "string"
        ? event.message
        : typeof nested?.message === "string"
          ? nested.message
          : undefined,
  };
}

export async function* mapCodexEvents(
  events: AsyncIterable<Record<string, unknown>>,
  initialResponseHeaders?: Headers,
  options?: Pick<StreamOptions, "signal">,
): AsyncGenerator<Record<string, unknown>> {
  const responseModelTracker = createResponseModelTracker();
  responseModelTracker.begin(initialResponseHeaders);
  for await (const event of withResponsesRequestAcceptance(
    events,
    responsesRequestLifecycle.get(options),
    options?.signal,
  )) {
    responseModelTracker.observeEvent(event);
    const type = typeof event.type === "string" ? event.type : undefined;
    if (!type) {
      continue;
    }

    if (type === "error") {
      const { code, message } = extractCodexEventError(event);
      throw new CodexApiError(`Codex error: ${message || code || JSON.stringify(event)}`, {
        code,
        payload: event,
      });
    }

    if (
      type === "response.done" ||
      type === "response.completed" ||
      type === "response.incomplete"
    ) {
      const response = isRecord(event.response) ? event.response : undefined;
      const normalizedResponse = response
        ? {
            ...response,
            status: normalizeCodexStatus(response.status),
            model: responseModelTracker.resolve(),
          }
        : response;
      yield {
        ...event,
        type: type === "response.done" ? "response.completed" : type,
        response: normalizedResponse,
      };
      return;
    }

    yield event;
  }
}

function normalizeCodexStatus(status: unknown): CodexResponseStatus | undefined {
  switch (status) {
    case "completed":
    case "incomplete":
    case "failed":
    case "cancelled":
    case "queued":
    case "in_progress":
      return status;
    default:
      return undefined;
  }
}
