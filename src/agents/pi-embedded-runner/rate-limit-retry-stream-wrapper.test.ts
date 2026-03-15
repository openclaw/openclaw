import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock sleepWithAbort so tests don't wait real delays.
const sleepWithAbortMock = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
vi.mock("../../infra/backoff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/backoff.js")>();
  return {
    ...actual,
    sleepWithAbort: (...args: unknown[]) =>
      sleepWithAbortMock(args[0] as number, args[1] as AbortSignal | undefined),
  };
});

import { createRateLimitRetryStreamWrapper } from "./rate-limit-retry-stream-wrapper.js";

const model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-completions",
  provider: "test-provider",
} as Model<"openai-completions">;

const context: Context = { messages: [] };

function make429Error(extra?: Record<string, unknown>): Error & { status: number } {
  return Object.assign(new Error("Too Many Requests"), { status: 429, ...extra });
}

function makeStreamFn(results: Array<() => ReturnType<StreamFn>>): StreamFn {
  let call = 0;
  return vi.fn(() => results[call++]()) as StreamFn;
}

describe("createRateLimitRetryStreamWrapper", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sleepWithAbortMock.mockClear();
  });

  it("passes through on success without retrying", async () => {
    const inner = makeStreamFn([() => createAssistantMessageEventStream()]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(inner).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
  });

  it("retries on 429 and succeeds on second attempt", async () => {
    const inner = makeStreamFn([
      () => Promise.reject(make429Error()) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(inner).toHaveBeenCalledTimes(2);
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(1);
  });

  it("retries up to 3 times then throws", async () => {
    const error = make429Error();
    const reject = () => Promise.reject(error) as unknown as ReturnType<StreamFn>;
    const inner = makeStreamFn([reject, reject, reject, reject]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await expect(wrapped(model, context, {})).rejects.toBe(error);
    // 1 initial + 3 retries = 4 calls
    expect(inner).toHaveBeenCalledTimes(4);
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(3);
  });

  it("retries when 429 is nested at err.response.status", async () => {
    const err = Object.assign(new Error("Too Many Requests"), {
      response: { status: 429 },
    });
    const inner = makeStreamFn([
      () => Promise.reject(err) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("retries when 429 is provided as string statusCode", async () => {
    const err = Object.assign(new Error("Too Many Requests"), {
      statusCode: "429",
    });
    const inner = makeStreamFn([
      () => Promise.reject(err) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-429 errors", async () => {
    const error = Object.assign(new Error("Internal Server Error"), { status: 500 });
    const inner = makeStreamFn([() => Promise.reject(error) as unknown as ReturnType<StreamFn>]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await expect(wrapped(model, context, {})).rejects.toBe(error);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
  });

  it("honors delta-seconds Retry-After header over backoff", async () => {
    const inner = makeStreamFn([
      () =>
        Promise.reject(
          make429Error({ headers: { "retry-after": "5" } }),
        ) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(sleepWithAbortMock).toHaveBeenCalledWith(5_000, undefined);
  });

  it("honors HTTP-date Retry-After header over backoff", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-03-11T15:00:00.000Z");
    vi.setSystemTime(now);
    const retryAt = new Date("2026-03-11T15:00:10.000Z"); // 10s in the future
    const err = Object.assign(new Error("Too Many Requests"), {
      status: 429,
      headers: { "retry-after": retryAt.toUTCString() },
    });
    const inner = makeStreamFn([
      () => Promise.reject(err) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(sleepWithAbortMock).toHaveBeenCalledWith(10_000, undefined);
    vi.useRealTimers();
  });

  it("reads Retry-After from err.response.headers (Axios-style)", async () => {
    const err = Object.assign(new Error("Too Many Requests"), {
      status: 429,
      response: { status: 429, headers: { "retry-after": "7" } },
    });
    const inner = makeStreamFn([
      () => Promise.reject(err) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(sleepWithAbortMock).toHaveBeenCalledWith(7_000, undefined);
  });

  it("reads Retry-After from Headers instance", async () => {
    const headers = new Headers();
    headers.set("retry-after", "3");
    const err = Object.assign(new Error("Too Many Requests"), {
      status: 429,
      headers,
    });
    const inner = makeStreamFn([
      () => Promise.reject(err) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(sleepWithAbortMock).toHaveBeenCalledWith(3_000, undefined);
  });

  it("caps excessively large Retry-After at MAX_RETRY_AFTER_MS", async () => {
    const inner = makeStreamFn([
      () =>
        Promise.reject(
          make429Error({ headers: { "retry-after": "86400" } }),
        ) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(sleepWithAbortMock).toHaveBeenCalledWith(30_000, undefined);
  });

  it("does not retry when abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = make429Error();
    const inner = makeStreamFn([() => Promise.reject(error) as unknown as ReturnType<StreamFn>]);
    const wrapped = createRateLimitRetryStreamWrapper(inner, controller.signal);
    await expect(wrapped(model, context, {})).rejects.toBe(error);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
  });
});
