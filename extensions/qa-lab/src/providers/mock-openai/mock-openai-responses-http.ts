import type { ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { writeJson } from "../shared/http-json.js";
import {
  type QaMockProviderDispatchResult,
  writeSse,
  writeSseHeaders,
} from "./mock-openai-contracts.js";

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
    if (stream && dispatched.responseKeepaliveMs !== undefined) {
      await writeHeldSse(
        res,
        dispatched,
        dispatched.responsePauseMs,
        dispatched.responseKeepaliveMs,
      );
      return;
    }
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

// A live provider can start a response, then hold it open with SSE comment
// keepalives while making no model progress.
async function writeHeldSse(
  res: ServerResponse,
  dispatched: QaMockProviderDispatchResult,
  pauseMs: number,
  keepaliveMs: number,
): Promise<void> {
  const [first, ...rest] = dispatched.events;
  writeSseHeaders(res);
  if (first) {
    res.write(`data: ${JSON.stringify(first)}\n\n`);
  }
  const keepalive = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) {
      res.write(": keepalive\n\n");
    }
  }, keepaliveMs);
  try {
    await sleep(pauseMs);
  } finally {
    clearInterval(keepalive);
  }
  await writeSse(res, rest, "responses", dispatched.previewPauseMs, dispatched.previewPause);
  dispatched.onResponseSent?.();
}
