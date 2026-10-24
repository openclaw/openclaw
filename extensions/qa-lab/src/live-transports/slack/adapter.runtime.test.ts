import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "../../bus-state.js";
import type { QaChannelE2eDriver } from "../shared/channel-e2e.types.js";
import { slackRequest } from "./slack-capture.test-helpers.js";

const mocks = vi.hoisted(() => ({
  acquireCaptureStore: vi.fn(),
  acquireCredentialLease: vi.fn(),
  captureRelease: vi.fn(),
  createCaptureReader: vi.fn(),
  credentialRelease: vi.fn(),
  getSlackIdentity: vi.fn(),
  heartbeatStop: vi.fn(),
  heartbeatThrowIfFailed: vi.fn(),
  prepareFlow: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/proxy-capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/proxy-capture")>()),
  acquireDebugProxyCaptureStoreAsync: mocks.acquireCaptureStore,
  createDebugProxyCaptureReaderAsync: mocks.createCaptureReader,
}));

vi.mock("../shared/credential-lease.runtime.js", () => ({
  acquireQaCredentialLease: mocks.acquireCredentialLease,
  startQaCredentialLeaseHeartbeat: () => ({
    stop: mocks.heartbeatStop,
    throwIfFailed: mocks.heartbeatThrowIfFailed,
    whenFailed: new Promise<Error>(() => {}),
  }),
}));

vi.mock("./scenario-environment.js", () => ({
  createSlackQaScenarioEnvironment: () => ({ prepareFlow: mocks.prepareFlow }),
}));

vi.mock("./slack-live.config.js", () => ({
  buildSlackQaConfig: () => ({}),
  parseSlackQaCredentialPayload: vi.fn(),
  resolveSlackQaRuntimeEnv: vi.fn(),
}));

vi.mock("./slack-live.message-observations.js", () => ({
  waitForSlackChannelStable: vi.fn(),
}));

vi.mock("./slack-live.observations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./slack-live.observations.js")>()),
  getSlackIdentity: mocks.getSlackIdentity,
  listSlackMessages: vi.fn(),
  listSlackThreadMessages: vi.fn(),
}));

vi.mock("./slack-plugin.runtime.js", async () => {
  // Vitest hoists this factory before static imports; keep the real plugin in its module graph.
  const runtime = await import("@openclaw/slack/test-api.js");
  return { loadSlackQaRuntime: () => runtime };
});

import { createSlackQaTransportAdapter, testing } from "./adapter.runtime.js";
import type { SlackQaFetchFunction as FetchFunction } from "./slack-live.contracts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function expectLeaseReleased() {
  expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
  expect(mocks.credentialRelease).toHaveBeenCalledOnce();
}
const emptyCaptureReader = () => ({
  getSessionEvents: vi.fn(async () => []),
  readBlob: vi.fn(async () => null),
});
const messageRecorder = () => ({
  addInboundMessage: vi.fn(),
  addOutboundMessage: vi.fn(),
  editMessage: vi.fn(),
});
const privateEvidence = "preserve private evidence";
const uncertainReceipt = "without a definitive Slack receipt";
function expectEvidence(artifact: { evidence: unknown[] }, evidence: Record<string, unknown>) {
  expect(artifact.evidence).toContainEqual(expect.objectContaining(evidence));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    vi.stubEnv(key, "");
    vi.stubEnv(key.toLowerCase(), "");
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("Unexpected Slack request"))),
  );
  mocks.acquireCaptureStore.mockResolvedValue({
    store: emptyCaptureReader(),
    release: mocks.captureRelease,
  });
  mocks.createCaptureReader.mockReturnValue(emptyCaptureReader());
  mocks.acquireCredentialLease.mockResolvedValue({
    payload: {
      channelId: "C123",
      driverBotToken: "driver-token",
      sutAppToken: "sut-app-token",
      sutBotToken: "sut-token",
    },
    release: mocks.credentialRelease,
  });
  mocks.getSlackIdentity
    .mockResolvedValueOnce({ userId: "U-driver" })
    .mockResolvedValueOnce({ userId: "U-sut" });
  mocks.prepareFlow.mockResolvedValue({});
});

function holdSlackResponse() {
  const started = createDeferred<AbortSignal | undefined>();
  let body: ReadableStreamDefaultController<Uint8Array>;
  let signal: AbortSignal | undefined;
  const abort = () => body.error(signal?.reason);
  return {
    started: started.promise,
    respond(init: Parameters<FetchFunction>[1]) {
      signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller;
            signal?.addEventListener("abort", abort, { once: true });
            started.resolve(signal);
          },
        }),
      );
    },
    resolve(payload: Record<string, unknown>) {
      signal?.removeEventListener("abort", abort);
      body.enqueue(Buffer.from(JSON.stringify(payload)));
      body.close();
    },
  };
}

async function nativeAdapterFixture(
  intercept: (method: string, init: Parameters<FetchFunction>[1]) => Response | undefined,
  capturedEvents: Array<Record<string, unknown>> = [],
) {
  const deadlines = new WeakMap<AbortSignal, AbortController>();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const deadline = new AbortController();
    deadlines.set(deadline.signal, deadline);
    return deadline.signal;
  });
  const requests: Array<{ method: string; body: URLSearchParams }> = [];
  let nextMessageId = 1;
  const fetchImpl: FetchFunction = async (input, init) => {
    const url = input instanceof Request ? input.url : input;
    const method = new URL(url).pathname.split("/").at(-1)!;
    requests.push({
      method,
      body: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
    });
    const intercepted = intercept(method, init);
    if (intercepted) {
      return intercepted;
    }
    const replies: Record<string, () => Record<string, unknown>> = {
      "auth.test": () => ({
        team_id: "T_QA",
        user_id:
          new Headers(init?.headers).get("authorization") === "Bearer driver-token"
            ? "U-driver"
            : "U-sut",
      }),
      "conversations.history": () => ({ messages: [] }),
      "chat.postMessage": () => ({ channel: "C123", ts: `${nextMessageId++}.000000` }),
      "chat.delete": () => ({}),
      "files.getUploadURLExternal": () => ({
        file_id: "F_UPLOAD",
        upload_url: "https://slack.test/upload-data",
      }),
    };
    const reply = Object.hasOwn(replies, method) ? replies[method] : undefined;
    if (!reply) {
      throw new Error(`Unexpected Slack request: ${method}`);
    }
    return Response.json({ ok: true, ...reply() });
  };
  vi.stubGlobal("fetch", fetchImpl);
  mocks.createCaptureReader.mockReturnValue({
    getSessionEvents: async () => capturedEvents.toReversed(),
    readBlob: async () => null,
  });
  const outputDir = tempDirs.make("slack-adapter-settlement-");
  const controller = new AbortController();
  const adapter = await createSlackQaTransportAdapter({
    channelId: "slack",
    driver: "live",
    outputDir,
    credentials: {
      acquire: mocks.acquireCredentialLease,
      startHeartbeat: () => ({
        getFailure: () => null,
        stop: mocks.heartbeatStop,
        throwIfFailed: mocks.heartbeatThrowIfFailed,
      }),
    },
    adapterOptions: { agentE2e: true },
    messages: messageRecorder(),
  });
  const prepared = await adapter.prepareFlow?.({
    config: {},
    gateway: {
      baseUrl: "http://127.0.0.1:1",
      tempRoot: outputDir,
      workspaceDir: outputDir,
      runtimeEnv: {},
      call: async () => ({}),
    },
    outputDir,
    scenarioId: "settlement",
    scenarioTitle: "Bounded Slack settlement",
    signal: controller.signal,
    timeoutMs: 30_000,
    waitForConfigRestartSettle: vi.fn(),
  });
  const requestMethods = (since = 0) => requests.slice(since).map(({ method }) => method);
  return {
    adapter,
    controller,
    // SAFETY: agentE2e: true exposes the real typed channelE2e driver from prepareFlow.
    driver: prepared?.channelE2e as QaChannelE2eDriver,
    outputDir,
    requests,
    requestMethods,
    deletedMessageIds: () =>
      requests
        .filter((request) => request.method === "chat.delete")
        .map((request) => request.body.get("ts")),
    expire(signal: AbortSignal | undefined) {
      const deadline = signal && deadlines.get(signal);
      expect(deadline, "The dispatched HTTP request must have an owned deadline").toBeDefined();
      deadline!.abort(new DOMException("Slack request deadline", "TimeoutError"));
    },
    async artifact() {
      return JSON.parse(
        await fs.readFile(path.join(outputDir, "settlement-slack-e2e.json"), "utf8"),
      );
    },
    async cleanup() {
      await adapter.cleanup?.();
      await adapter.cleanupAfterGatewayStop?.();
    },
  };
}

function busObservationFixture() {
  const state = createQaBusState();
  const busMessageIds = new Map<string, string>();
  const base = {
    accountId: "sut",
    busMessageIds,
    logicalConversationId: "C123",
    observedText: new Map<string, string>(),
    sutUserId: "U123",
    messages: state,
  };
  return {
    state,
    observe: (text: string, ts = "123.000001", thread_ts?: string) =>
      testing.recordSlackObservedMessage({
        ...base,
        message: { text, ts, thread_ts, user: "U123" },
      }),
    busMessageIds,
  };
}

describe("Slack live adapter reconciliation", () => {
  it("does not acquire a capture reader before a capture is requested", async () => {
    const adapter = await createSlackQaTransportAdapter({
      messages: messageRecorder(),
    } as never);
    const runtimeEnv = { OPENCLAW_STATE_DIR: "/candidate/state" };
    const input = {
      config: {},
      gateway: { runtimeEnv },
      outputDir: "/output",
      scenarioId: "slack-progress",
      scenarioTitle: "Slack progress",
      timeoutMs: 30_000,
      waitForConfigRestartSettle: vi.fn(),
    } as never;

    await adapter.prepareFlow?.(input);
    await adapter.prepareFlow?.(input);
    await adapter.cleanup?.();
    await adapter.cleanupAfterGatewayStop?.();

    expect(mocks.createCaptureReader).not.toHaveBeenCalled();
    expect(mocks.acquireCaptureStore).not.toHaveBeenCalled();
    expect(mocks.captureRelease).not.toHaveBeenCalled();
    expectLeaseReleased();
  });

  it("aborts an in-flight observer fetch when the adapter stops", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl: FetchFunction = async (_url, init) => {
      observedSignal = init?.signal;
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("observer aborted")), {
          once: true,
        });
      });
      throw new Error("unreachable");
    };
    const lifecycle = new AbortController();
    const request = new AbortController();

    const pending = testing.withSlackLifecycleSignal(fetchImpl, lifecycle.signal)(
      "https://slack.test",
      { signal: request.signal },
    );
    lifecycle.abort();

    await expect(pending).rejects.toThrow("observer aborted");
    expect(observedSignal?.aborted).toBe(true);
  });

  it("records streamed updates to the same Slack timestamp as bus edits", async () => {
    const { state, observe } = busObservationFixture();

    for (const text of ["QA-", "QA-CHANNEL-BASELINE-OK"]) {
      await observe(text);
    }

    const snapshot = state.getSnapshot();
    expect(snapshot.messages).toMatchObject([{ text: "QA-CHANNEL-BASELINE-OK" }]);
    expect(snapshot.events.map((event) => event.kind)).toEqual([
      "outbound-message",
      "message-edited",
    ]);
  });

  it("maps observed thread replies to the root bus message", async () => {
    const { state, observe, busMessageIds } = busObservationFixture();
    const root = state.addInboundMessage({
      accountId: "sut",
      conversation: { id: "C123", kind: "channel" },
      senderId: "U456",
      text: "root",
    });
    busMessageIds.set("123.000001", root.id);
    await observe("thread reply", "123.000002", "123.000001");

    expect(state.getSnapshot().messages.at(-1)).toMatchObject({
      direction: "outbound",
      text: "thread reply",
      threadId: root.id,
    });
  });
});

describe("Slack agent E2E request settlement", () => {
  it("captures final writes after the Gateway invalidates an earlier reader", async () => {
    const f = await nativeAdapterFixture(() => undefined);
    await f.driver.send({ text: "owned before restart" });
    const previousReader = mocks.createCaptureReader.mock.results[0]?.value;
    previousReader.getSessionEvents = async () => {
      throw new Error("STATE_DATABASE_READ_ADMISSION_INVALIDATED");
    };
    mocks.createCaptureReader.mockReturnValue(emptyCaptureReader());

    await expect(f.adapter.captureBeforeGatewayCleanup?.()).resolves.toBeUndefined();
    await f.cleanup();
    expect((await f.artifact()).ownedMessages).toMatchObject([{ deleted: true }]);
  });

  it("retains uncertain final Gateway writes while cleaning only known-owned receipts", async () => {
    const capturedEvents: Array<Record<string, unknown>> = [];
    const f = await nativeAdapterFixture(() => undefined, capturedEvents);
    const owned = await f.driver.send({ text: "owned root" });
    capturedEvents.push(
      slackRequest(1, "chat.postMessage", {
        thread_ts: owned.id,
        text: "unconfirmed SUT reply",
      }),
    );
    await f.adapter.cleanup?.();
    await expect(f.adapter.captureBeforeGatewayCleanup?.()).rejects.toThrow(
      "final capture is incomplete",
    );
    capturedEvents.length = 0;
    await expect(f.adapter.cleanupAfterGatewayStop?.()).rejects.toThrow(privateEvidence);
    expectEvidence(await f.artifact(), {
      operation: "Gateway chat.postMessage",
      outcome: "uncertain",
      requestEventId: 1,
      threadId: owned.id,
      detail: "response-not-captured",
    });
    expect(f.deletedMessageIds()).toEqual([owned.id]);
    expect(mocks.credentialRelease).toHaveBeenCalledOnce();
  });

  it.each(["send", "upload", "read"] as const)(
    "settles a stuck %s response at the HTTP deadline without replaying it",
    async (operation) => {
      const response = holdSlackResponse();
      const method =
        operation === "send"
          ? "chat.postMessage"
          : operation === "upload"
            ? "upload-data"
            : "conversations.history";
      let armed = false;
      const f = await nativeAdapterFixture((requested, init) =>
        armed && requested === method ? response.respond(init) : undefined,
      );
      armed = true;
      const uploadPath = path.join(f.outputDir, "fixture.txt");
      if (operation === "upload") {
        await fs.writeFile(uploadPath, "bounded upload");
      }
      const baseline = f.requests.length;
      const operationPromise =
        operation === "send"
          ? f.driver.send({ text: "unknown outcome" })
          : operation === "upload"
            ? f.driver.upload({ path: uploadPath, mention: false })
            : f.driver.read({});
      const rejected = expect(operationPromise).rejects.toThrow("stopped");
      const signal = await response.started;
      f.controller.abort(new Error("stopped"));
      await f.adapter.cleanup?.();
      expect(signal?.aborted).toBe(false);
      const cleaning = f.adapter.cleanupAfterGatewayStop!();
      const cleaned =
        operation === "read"
          ? expect(cleaning).resolves.toBeUndefined()
          : expect(cleaning).rejects.toThrow(privateEvidence);
      f.expire(signal);
      await rejected;
      await cleaned;

      expect(f.requestMethods(baseline)).toEqual(
        operation === "upload" ? ["files.getUploadURLExternal", "upload-data"] : [method],
      );
      const artifact = await f.artifact();
      expect(artifact).toMatchObject({ ownedMessages: [], ownedFileIds: [] });
      if (operation !== "read") {
        expectEvidence(artifact, {
          operation: operation === "send" ? "chat.postMessage" : "files.uploadV2",
          outcome: "uncertain",
        });
      }
      expectLeaseReleased();
    },
  );

  it("continues cleanup after a stuck deletion settles and releases the lease", async () => {
    const response = holdSlackResponse();
    let deletes = 0;
    const f = await nativeAdapterFixture((method, init) =>
      method === "chat.delete" && ++deletes === 1 ? response.respond(init) : undefined,
    );
    const first = await f.driver.send({ text: "first receipt" });
    const second = await f.driver.send({ text: "second receipt" });
    const cleaned = expect(f.cleanup()).rejects.toThrow(privateEvidence);
    const signal = await response.started;
    f.expire(signal);
    await cleaned;

    expect(f.deletedMessageIds()).toEqual([second.id, first.id]);
    const artifact = await f.artifact();
    expect(artifact.ownedMessages).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ id: first.id }),
        deleted: true,
      }),
      { message: expect.objectContaining({ id: second.id }) },
    ]);
    expectEvidence(artifact, {
      operation: "cleanup chat.delete",
      messageId: second.id,
      outcome: "failed",
      detail: expect.stringContaining(uncertainReceipt),
    });
    expectLeaseReleased();
  });

  it("keeps a late acknowledged receipt after cancellation for exact cleanup", async () => {
    const response = holdSlackResponse();
    const f = await nativeAdapterFixture((method, init) =>
      method === "chat.postMessage" ? response.respond(init) : undefined,
    );
    const sent = expect(f.driver.send({ text: "late receipt" })).rejects.toThrow("stopped");
    const signal = await response.started;
    f.controller.abort(new Error("stopped"));
    expect(signal?.aborted).toBe(false);
    response.resolve({ ok: true, channel: "C123", ts: "7.000000" });
    await sent;
    await expect(f.driver.send({ text: "must not dispatch" })).rejects.toThrow("stopped");
    await f.cleanup();

    expect(f.requestMethods().filter((method) => method === "chat.postMessage")).toHaveLength(1);
    expect(f.deletedMessageIds()).toEqual(["7.000000"]);
    expect((await f.artifact()).ownedMessages).toMatchObject([
      { message: { id: "7.000000" }, deleted: true },
    ]);
    expect(mocks.credentialRelease).toHaveBeenCalledOnce();
  });

  it("does not wait or replay a native write refused with a long Retry-After", async () => {
    const f = await nativeAdapterFixture((method) =>
      method === "chat.postMessage"
        ? new Response("rate limited", { status: 429, headers: { "retry-after": "86400" } })
        : undefined,
    );
    await expect(f.driver.send({ text: "refused write" })).rejects.toThrow(uncertainReceipt);
    await expect(f.cleanup()).rejects.toThrow(privateEvidence);
    expect(f.requestMethods().filter((method) => method === "chat.postMessage")).toHaveLength(1);
    expect(f.requestMethods().filter((method) => method === "chat.delete")).toEqual([]);
    expect(mocks.credentialRelease).toHaveBeenCalledOnce();
  });
});
