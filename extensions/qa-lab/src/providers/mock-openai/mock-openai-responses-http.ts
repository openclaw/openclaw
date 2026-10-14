import type { ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { writeJson } from "../shared/http-json.js";
import { type QaMockProviderDispatchResult, writeSse } from "./mock-openai-contracts.js";

export async function writeMockOpenAiResponsesHttp(
  res: ServerResponse,
  stream: boolean,
  dispatched: QaMockProviderDispatchResult,
): Promise<void> {
  if (dispatched.failure) {
    if (dispatched.failure.retryAfterSeconds !== undefined) {
      res.setHeader("retry-after", String(dispatched.failure.retryAfterSeconds));
    }
    writeJson(res, dispatched.failure.status, {
      error: {
        type: dispatched.failure.type,
        ...(dispatched.failure.code ? { code: dispatched.failure.code } : {}),
        message: dispatched.failure.message,
      },
    });
    return;
  }
  if (dispatched.responsePauseMs !== undefined) {
    await sleep(dispatched.responsePauseMs);
  }
  if (!stream) {
    const completion = dispatched.events.at(-1);
    if (!completion || completion.type !== "response.completed") {
      writeJson(res, 500, { error: "mock completion failed" });
      return;
    }
    writeJson(res, 200, completion.response);
    dispatched.onResponseSent?.();
    return;
  }
  await writeSse(
    res,
    dispatched.events,
    "responses",
    dispatched.previewPauseMs,
    dispatched.previewPause,
  );
  dispatched.onResponseSent?.();
}
