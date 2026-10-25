import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { RelayFetch } from "./relay-fetch.js";

type Sender = ConstructorParameters<typeof RelayFetch>[0];

function stringField(value: unknown, key: string): string {
  const field = asOptionalRecord(value)?.[key];
  if (typeof field !== "string") {
    throw new Error(`Missing string ${key}`);
  }
  return field;
}

function fixture(implementation: Sender = async () => ({})) {
  const send = vi.fn<Sender>(implementation);
  const fetch = new RelayFetch(send);
  onTestFinished(() => fetch.dispose());
  const owner = {};
  const events: Array<{ method: string; params: unknown }> = [];
  const emit = (method: string, params: unknown) => events.push({ method, params });
  function command(method: string, params?: Record<string, unknown>, caller = owner) {
    const result = fetch.command(caller, emit, method, params);
    if (!result) {
      throw new Error(`Unexpected unhandled command: ${method}`);
    }
    return result;
  }
  function pause(nativeId: string, params: Record<string, unknown> = {}, auth = false) {
    fetch.event(auth ? "Fetch.authRequired" : "Fetch.requestPaused", {
      requestId: nativeId,
      ...params,
    });
    return stringField(events.at(-1)?.params, "requestId");
  }
  async function stream(nativeId = "stream") {
    const requestId = pause(nativeId, { responseStatusCode: 200 });
    return {
      requestId,
      handle: stringField(await command("Fetch.takeResponseBodyAsStream", { requestId }), "stream"),
    };
  }
  return { fetch, send, owner, emit, events, command, pause, stream };
}

const streamSender =
  (stream: string): Sender =>
  async (method) =>
    method === "Fetch.takeResponseBodyAsStream" ? { stream } : {};

async function blockedEnabled(blocked: string, fallback: Sender = async () => ({})) {
  const started = createDeferred<void>();
  const pending = createDeferred<unknown>();
  const f = fixture(async (method, params) => {
    if (method === blocked) {
      started.resolve();
      return pending.promise;
    }
    return fallback(method, params);
  });
  await f.command("Fetch.enable");
  return { f, started, pending };
}

function expectMethods(f: ReturnType<typeof fixture>, ...methods: string[]) {
  expect(f.send.mock.calls.map(([method]) => method)).toEqual(methods);
}

async function enabledFixture(implementation?: Sender) {
  const f = fixture(implementation);
  await f.command("Fetch.enable");
  return f;
}

describe("RelayFetch request and stream ownership", () => {
  it("keeps response-body reads nonterminal and does not serialize another request", async () => {
    const { f, started, pending: body } = await blockedEnabled("Fetch.getResponseBody");
    const response = f.pause("response", { responseStatusCode: 200 });
    const reading = f.command("Fetch.getResponseBody", { requestId: response });
    await started.promise;
    const other = f.pause("other");
    await f.command("Fetch.continueRequest", { requestId: other });
    await expect(f.command("Fetch.continueResponse", { requestId: response })).rejects.toThrow(
      /in flight/,
    );
    body.resolve({ body: "ok", base64Encoded: false });
    await expect(reading).resolves.toEqual({ body: "ok", base64Encoded: false });
    await f.command("Fetch.continueResponse", { requestId: response });
  });

  it.each(["auth", "response"])(
    "does not let an old continuation erase a replacement %s pause",
    async (stage) => {
      const { f, started, pending: continued } = await blockedEnabled("Fetch.continueRequest");
      const requestId = f.pause("same");
      const first = f.command("Fetch.continueRequest", { requestId });
      await started.promise;
      const next = f.pause(
        "same",
        stage === "response" ? { responseErrorReason: "Failed" } : {},
        stage === "auth",
      );
      continued.resolve({});
      await first;
      const method = stage === "auth" ? "Fetch.continueWithAuth" : "Fetch.failRequest";
      const params =
        stage === "auth"
          ? { authChallengeResponse: { response: "CancelAuth" } }
          : { errorReason: "Aborted" };
      await f.command(method, { requestId: next, ...params });
      expect(f.send.mock.calls.at(-1)).toEqual([method, { requestId: "same", ...params }]);
    },
  );

  it("prefixes redirect ids per lease and rejects stale ids after replacement", async () => {
    const f = await enabledFixture();
    const first = f.pause("job.0");
    await f.command("Fetch.continueRequest", { requestId: first });
    f.pause("job.1", { redirectedRequestId: "job.0", networkId: "network" });
    expect(f.events.at(-1)?.params).toMatchObject({
      redirectedRequestId: first,
      networkId: "network",
    });
    await f.command("Fetch.disable");
    await f.command("Fetch.enable");
    const replacement = f.pause("job.0");
    expect(replacement).not.toBe(first);
    await expect(f.command("Fetch.continueRequest", { requestId: first })).rejects.toThrow(
      /requestId/,
    );
  });

  it("blocks explicit disable while a taken stream pause is unresolved", async () => {
    const f = await enabledFixture(streamSender("native"));
    const { requestId, handle } = await f.stream();
    await expect(f.command("Fetch.disable")).rejects.toThrow(/failed or fulfilled/);
    await expect(f.command("Fetch.enable", undefined, {})).rejects.toThrow(/owned/);
    await f.command("Fetch.failRequest", { requestId, errorReason: "Aborted" });
    await f.command("Fetch.disable");
    expect(
      f.fetch.command(f.owner, f.emit, "IO.read", { handle: "native-unrelated" }),
    ).toBeUndefined();
    await f.command("IO.close", { handle });
  });

  it.each(["IO.read", "IO.close"])(
    "fences a stream after ambiguous %s completion",
    async (method) => {
      const failure = new Error("stream completion unknown");
      const { f, started, pending } = await blockedEnabled(method, streamSender("native"));
      const { handle } = await f.stream();
      const operation = f.command(method, { handle });
      await started.promise;
      if (method === "IO.read") {
        await expect(f.command(method, { handle })).rejects.toThrow(/read in flight/);
      }
      pending.reject(failure);
      await expect(operation).rejects.toBe(failure);
      const beforeRetry = f.send.mock.calls.length;
      if (method === "IO.close") {
        await expect(f.command("IO.read", { handle: "native" }, {})).rejects.toThrow(
          /stream handle/,
        );
      }
      await expect(f.command(method, { handle })).rejects.toThrow(
        method === "IO.read" ? /no longer readable/ : /stream handle/,
      );
      expect(f.send).toHaveBeenCalledTimes(beforeRetry);
      if (method === "IO.read") {
        await f.command("IO.close", { handle });
      }
    },
  );
});

describe("RelayFetch uncertain state and retirement", () => {
  class CompletedLookingError extends Error {}

  it.each([
    ["initial enable", false, "Fetch.enable"],
    ["enable update", true, "Fetch.enable"],
    ["request resolution", true, "Fetch.continueRequest"],
    ["explicit disable", true, "Fetch.disable"],
  ])("fences every physical Fetch error from %s", async (_label, preEnable, method) => {
    const failure = new CompletedLookingError("native command returned an error");
    const f = fixture();
    if (preEnable) {
      await f.command("Fetch.enable");
    }
    const params =
      method === "Fetch.continueRequest" ? { requestId: f.pause("pending") } : undefined;
    f.send.mockRejectedValueOnce(failure);
    await expect(f.command(method, params)).rejects.toBe(failure);
    const before = f.send.mock.calls.length;
    await expect(f.command("Fetch.enable", undefined, {})).rejects.toBe(failure);
    await expect(f.command("Fetch.disable")).rejects.toBe(failure);
    await expect(f.fetch.close(f.owner)).rejects.toBe(failure);
    expect(f.send).toHaveBeenCalledTimes(before);
    const eventCount = f.events.length;
    f.fetch.event("Fetch.requestPaused", { requestId: "late" });
    expect(f.events).toHaveLength(eventCount);
  });

  it("closes residual streams when owner close overtakes explicit disable", async () => {
    const { f, started, pending } = await blockedEnabled(
      "Fetch.disable",
      streamSender("native-stream"),
    );
    const { requestId } = await f.stream();
    await f.command("Fetch.failRequest", { requestId, errorReason: "Aborted" });
    const disabling = f.command("Fetch.disable");
    await started.promise;
    const closing = f.fetch.close(f.owner);
    pending.resolve({});
    await Promise.all([disabling, closing]);
    expect(f.send.mock.calls.at(-1)).toEqual(["IO.close", { handle: "native-stream" }]);
  });

  it("prepares physical retirement without awaiting a hanging operation", async () => {
    const { f, started, pending } = await blockedEnabled(
      "Fetch.getResponseBody",
      streamSender("native-stream"),
    );
    const { handle } = await f.stream();
    f.pause("request");
    f.pause("auth", {}, true);
    const pendingBody = f.pause("body", { responseStatusCode: 200 });
    const bodyRead = f.command("Fetch.getResponseBody", { requestId: pendingBody });
    await started.promise;

    const retirement = f.fetch.prepareRetirement(100);
    expect(f.fetch.prepareRetirement(100)).toBe(retirement);
    await expect(retirement).resolves.toEqual({ errors: [] });
    expect(f.send.mock.calls.slice(3)).toEqual([
      ["Fetch.failRequest", { requestId: "stream", errorReason: "Aborted" }],
      ["Fetch.failRequest", { requestId: "request", errorReason: "Aborted" }],
      [
        "Fetch.continueWithAuth",
        { requestId: "auth", authChallengeResponse: { response: "CancelAuth" } },
      ],
      ["IO.close", { handle: "native-stream" }],
    ]);
    expect(f.send.mock.calls.some(([method]) => method === "Fetch.disable")).toBe(false);
    const eventCount = f.events.length;
    f.fetch.event("Fetch.requestPaused", { requestId: "late" });
    expect(f.events).toHaveLength(eventCount);
    await expect(f.command("IO.read", { handle })).rejects.toThrow(/detached/);

    pending.resolve({ body: "late", base64Encoded: false });
    await expect(bodyRead).rejects.toThrow(/retired/);
  });

  it.each(["rejected", "hung"])(
    "reports %s retirement cleanup without disabling Fetch",
    async (mode) => {
      const failure = new Error("cleanup failed");
      const { f, pending } = await blockedEnabled("Fetch.failRequest");
      f.pause("request");
      const retiring = f.fetch.prepareRetirement(mode === "hung" ? 10 : 100);
      if (mode === "rejected") {
        pending.reject(failure);
      }
      await expect(retiring).resolves.toEqual({
        errors: [
          mode === "rejected"
            ? failure
            : expect.objectContaining({ message: expect.stringMatching(/timed out/) }),
        ],
      });
      expectMethods(f, "Fetch.enable", "Fetch.failRequest");
    },
  );
  it.each(["Fetch.getResponseBody", "Fetch.takeResponseBodyAsStream"])(
    "never mutates a request whose %s completion is unknown",
    async (method) => {
      const f = await enabledFixture();
      const requestId = f.pause("body", { responseStatusCode: 200 });
      f.send.mockRejectedValueOnce(new Error("body completion unknown"));
      await expect(f.command(method, { requestId })).rejects.toThrow("body completion unknown");
      await f.fetch.prepareRetirement(100);
      expectMethods(f, "Fetch.enable", method);
    },
  );
});
