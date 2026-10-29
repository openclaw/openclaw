import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as telegramTransport from "./fetch.js";
import type {
  TelegramIngressWorkerCommand,
  TelegramIngressWorkerMessage,
} from "./telegram-ingress-worker.js";
import { runTelegramIngressWorkerRuntime } from "./telegram-ingress-worker.runtime.js";

type RuntimePort = Parameters<typeof runTelegramIngressWorkerRuntime>[0]["port"];

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

const emptyPoll = () => jsonResponse(200, { ok: true, result: [] });
const errorPoll = (error_code: number, description: string, parameters?: unknown) =>
  jsonResponse(error_code, { ok: false, error_code, description, parameters });
const expectMessage = (messages: TelegramIngressWorkerMessage[], fields: object) =>
  expect(messages).toContainEqual(expect.objectContaining(fields));

function createRuntime(
  responses: Response[],
  options: {
    stopAfterPollSuccesses?: number;
    timeoutSeconds?: number;
    acknowledge?: () => Promise<number>;
  } = {},
) {
  const calls: number[] = [];
  const pollBodies: Array<Record<string, unknown>> = [];
  const messages: TelegramIngressWorkerMessage[] = [];
  const listeners = new Set<(message: TelegramIngressWorkerCommand) => void>();
  let pollSuccesses = 0;
  const sendCommand = (message: TelegramIngressWorkerCommand) => {
    for (const listener of listeners) {
      listener(message);
    }
  };
  const port: RuntimePort = {
    postMessage(message) {
      messages.push(message);
      if (message.type === "updates") {
        const acknowledge = (updateId: number) =>
          sendCommand({
            type: "spool-ack",
            requestId: message.requestId,
            result: { ok: true, updateId },
          });
        if (options.acknowledge) {
          void options.acknowledge().then(acknowledge);
        } else {
          acknowledge(42);
        }
      }
      if (message.type === "poll-success") {
        pollSuccesses += 1;
        if (pollSuccesses >= (options.stopAfterPollSuccesses ?? 1)) {
          sendCommand({ type: "stop" });
        }
      }
    },
    onMessage(listener) {
      listeners.add(listener);
    },
    close() {},
  };
  const fetchImpl: typeof fetch = async (_url, init) => {
    calls.push(Date.now());
    pollBodies.push(
      JSON.parse((init?.body as string | undefined) ?? "{}") as Record<string, unknown>,
    );
    const responseIndex = Math.min(calls.length - 1, responses.length - 1);
    return expectDefined(responses[responseIndex], `Telegram response ${responseIndex}`);
  };
  vi.spyOn(telegramTransport, "resolveTelegramTransport").mockReturnValue({
    fetch: fetchImpl,
    sourceFetch: fetchImpl,
    close: async () => {},
  });
  const done = runTelegramIngressWorkerRuntime({
    options: {
      token: "test-auth-token",
      accountId: "acct",
      initialUpdateId: null,
      apiRoot: "https://api.telegram.test",
      timeoutSeconds: options.timeoutSeconds ?? 1,
    },
    port,
  });
  return {
    calls,
    pollBodies,
    messages,
    done,
    elapsed: () => calls.map((calledAt) => calledAt - expectDefined(calls[0], "first poll")),
  };
}

async function flushRuntime(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));
});

it("keeps short polling until a getUpdates request succeeds", async () => {
  const runtime = createRuntime([errorPoll(502, "Bad Gateway"), emptyPoll(), emptyPoll()], {
    stopAfterPollSuccesses: 2,
    timeoutSeconds: 30,
  });

  await flushRuntime();
  expectMessage(runtime.messages, { type: "poll-error", errorCode: 502 });
  await vi.advanceTimersByTimeAsync(1_000);
  await flushRuntime();
  await runtime.done;

  expect(runtime.pollBodies.map((body) => body.timeout)).toEqual([0, 0, 30]);
  for (const body of runtime.pollBodies) {
    expect(body.allowed_updates).toEqual(
      expect.arrayContaining(["message_reaction", "channel_post"]),
    );
    expect(body.allowed_updates).not.toContain("stopped_message_generation");
  }
});

it("backs off idle polls without hot spinning and resets immediately when activity resumes", async () => {
  const runtime = createRuntime(
    [
      ...Array.from({ length: 9 }, emptyPoll),
      jsonResponse(200, { ok: true, result: [{ update_id: 42 }] }),
      emptyPoll(),
    ],
    { stopAfterPollSuccesses: 11 },
  );

  await flushRuntime();
  await vi.advanceTimersByTimeAsync(4_550);
  await runtime.done;

  expect(runtime.elapsed()).toEqual([0, 0, 50, 150, 350, 750, 1_550, 2_550, 3_550, 4_550, 4_550]);
  expectMessage(runtime.messages, { type: "spooled", updateId: 42 });
});

it("advances getUpdates offset only after the whole response is acknowledged", async () => {
  const spoolGate = Promise.withResolvers<number>();
  const updates = [
    { update_id: 42, message: { text: "hi" } },
    { update_id: 44, message: { text: "again" } },
    { update_id: 42, message: { text: "hi" } },
  ];
  const { messages, pollBodies, calls, done } = createRuntime(
    [jsonResponse(200, { ok: true, result: updates }), emptyPoll()],
    { stopAfterPollSuccesses: 2, acknowledge: () => spoolGate.promise },
  );

  await flushRuntime();
  // The response stays intact while its one spool-ack is held.
  expect(messages.filter((message) => message.type === "updates")).toEqual([
    expect.objectContaining({ updates, queued: 3 }),
  ]);
  expect(messages.some((m) => m.type === "spooled")).toBe(false);
  expect(calls).toHaveLength(1);

  spoolGate.resolve(44);
  await flushRuntime();
  await vi.advanceTimersByTimeAsync(0);
  await done;

  expect(messages.filter((message) => message.type === "spooled")).toEqual([
    expect.objectContaining({ type: "spooled", updateId: 44 }),
  ]);
  // Second getUpdates must use offset = lastUpdateId + 1 only after spool-ack.
  expect(pollBodies[1]?.offset).toBe(45);
  expect(pollBodies.map((body) => body.timeout)).toEqual([0, 1]);
});

it("honors Telegram retry_after for getUpdates 429 responses", async () => {
  const runtime = createRuntime([
    errorPoll(429, "Too Many Requests: retry after 0.05", { retry_after: 0.05 }),
    emptyPoll(),
  ]);

  expect(runtime.calls).toHaveLength(1);
  await flushRuntime();
  expectMessage(runtime.messages, { type: "poll-error", errorCode: 429, retryAfterMs: 50 });
  await vi.advanceTimersByTimeAsync(49);
  expect(runtime.calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  await runtime.done;

  expect(runtime.calls).toHaveLength(2);
  expect(runtime.elapsed()).toEqual([0, 50]);
  expectMessage(runtime.messages, { type: "poll-success", count: 0 });
});

it.each([
  {
    name: "non-JSON",
    response: () =>
      new Response("<html>Bad Gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
  },
  { name: "JSON-null", response: () => jsonResponse(502, null) },
])("retries a $name getUpdates 502 response as a server error", async ({ response }) => {
  const runtime = createRuntime([response(), emptyPoll()]);

  expect(runtime.calls).toHaveLength(1);
  await flushRuntime();
  expectMessage(runtime.messages, {
    type: "poll-error",
    errorCode: 502,
    message: "Telegram getUpdates failed with HTTP 502",
  });
  await vi.advanceTimersByTimeAsync(1000);
  await runtime.done;

  expect(runtime.calls).toHaveLength(2);
});

it("propagates getUpdates 409 responses to the parent", async () => {
  const runtime = createRuntime([
    errorPoll(409, "Conflict: terminated by other getUpdates request"),
  ]);

  await expect(runtime.done).rejects.toThrow("Conflict: terminated by other getUpdates request");
  expectMessage(runtime.messages, { type: "poll-error", errorCode: 409 });
});
