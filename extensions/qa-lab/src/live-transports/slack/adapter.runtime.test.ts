// Qa Lab tests cover Slack live adapter message reconciliation.
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "../../bus-state.js";
import type { QaChannelE2eDriver } from "../shared/channel-e2e.types.js";

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

vi.mock("openclaw/plugin-sdk/proxy-capture", () => ({
  acquireDebugProxyCaptureStore: mocks.acquireCaptureStore,
  createDebugProxyCaptureReader: mocks.createCaptureReader,
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

vi.mock("./slack-live.observations.js", () => ({
  getSlackIdentity: mocks.getSlackIdentity,
  listSlackMessages: vi.fn(),
  listSlackThreadMessages: vi.fn(),
  sendSlackChannelMessage: vi.fn(),
}));

vi.mock("./slack-plugin.runtime.js", async () => {
  // Vitest hoists this factory before static imports; keep the real plugin in its module graph.
  const runtime = await import("@openclaw/slack/test-api.js");
  return { loadSlackQaRuntime: () => runtime };
});

import { createSlackQaTransportAdapter, testing } from "./adapter.runtime.js";
import type { SlackQaFetchFunction as FetchFunction } from "./slack-live.contracts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    vi.stubEnv(key, "");
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("Unexpected Slack request"))),
  );
  mocks.acquireCaptureStore.mockReturnValue({
    store: {
      getSessionEvents: vi.fn(() => []),
      readBlob: vi.fn(() => null),
    },
    release: mocks.captureRelease,
  });
  mocks.createCaptureReader.mockReturnValue({
    getSessionEvents: vi.fn(() => []),
    readBlob: vi.fn(() => null),
  });
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
    switch (method) {
      case "auth.test":
        return Response.json({
          ok: true,
          team_id: "T_QA",
          user_id:
            new Headers(init?.headers).get("authorization") === "Bearer driver-token"
              ? "U-driver"
              : "U-sut",
        });
      case "conversations.history":
        return Response.json({ ok: true, messages: [] });
      case "chat.postMessage":
        return Response.json({ ok: true, channel: "C123", ts: `${nextMessageId++}.000000` });
      case "chat.delete":
        return Response.json({ ok: true });
      case "files.getUploadURLExternal":
        return Response.json({
          ok: true,
          file_id: "F_UPLOAD",
          upload_url: "https://slack.test/upload-data",
        });
      default:
        throw new Error(`Unexpected Slack request: ${method}`);
    }
  };
  vi.stubGlobal("fetch", fetchImpl);
  mocks.createCaptureReader.mockReturnValue({
    getSessionEvents: () => capturedEvents.toReversed(),
    readBlob: () => null,
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
    messages: {
      addInboundMessage: vi.fn(),
      addOutboundMessage: vi.fn(),
      editMessage: vi.fn(),
    },
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
  return {
    adapter,
    controller,
    // SAFETY: agentE2e: true exposes the real typed channelE2e driver from prepareFlow.
    driver: prepared?.channelE2e as QaChannelE2eDriver,
    outputDir,
    requests,
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

describe("Slack live adapter reconciliation", () => {
  it("reuses a read-only capture reader for the exact candidate runtime environment", async () => {
    const adapter = await createSlackQaTransportAdapter({
      messages: {
        addInboundMessage: vi.fn(),
        addOutboundMessage: vi.fn(),
        editMessage: vi.fn(),
      },
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

    expect(mocks.createCaptureReader).toHaveBeenCalledOnce();
    expect(mocks.createCaptureReader).toHaveBeenCalledWith({ env: runtimeEnv });
    expect(mocks.acquireCaptureStore).not.toHaveBeenCalled();
    expect(mocks.captureRelease).not.toHaveBeenCalled();
    expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
    expect(mocks.credentialRelease).toHaveBeenCalledOnce();
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
      {
        signal: request.signal,
      },
    );
    lifecycle.abort();

    await expect(pending).rejects.toThrow("observer aborted");
    expect(observedSignal?.aborted).toBe(true);
  });

  it("records streamed updates to the same Slack timestamp as bus edits", async () => {
    const state = createQaBusState();
    const busMessageIds = new Map<string, string>();
    const observedText = new Map<string, string>();
    const messages: Parameters<typeof testing.recordSlackObservedMessage>[0]["messages"] = {
      addInboundMessage: (input) => state.addInboundMessage(input),
      addOutboundMessage: (input) => state.addOutboundMessage(input),
      editMessage: (input) => state.editMessage(input),
    };
    const base = {
      accountId: "sut",
      busMessageIds,
      logicalConversationId: "C123",
      messages,
      observedText,
      sutUserId: "U123",
    };

    await testing.recordSlackObservedMessage({
      ...base,
      message: { text: "QA-", ts: "123.000001", user: "U123" },
    });
    await testing.recordSlackObservedMessage({
      ...base,
      message: { text: "QA-CHANNEL-BASELINE-OK", ts: "123.000001", user: "U123" },
    });

    const snapshot = state.getSnapshot();
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]?.text).toBe("QA-CHANNEL-BASELINE-OK");
    expect(snapshot.events.map((event) => event.kind)).toEqual([
      "outbound-message",
      "message-edited",
    ]);
  });

  it("maps observed thread replies to the root bus message", async () => {
    const state = createQaBusState();
    const root = state.addInboundMessage({
      accountId: "sut",
      conversation: { id: "C123", kind: "channel" },
      senderId: "U456",
      text: "root",
    });
    const busMessageIds = new Map([["123.000001", root.id]]);

    await testing.recordSlackObservedMessage({
      accountId: "sut",
      busMessageIds,
      logicalConversationId: "C123",
      message: {
        text: "thread reply",
        thread_ts: "123.000001",
        ts: "123.000002",
        user: "U123",
      },
      messages: {
        addInboundMessage: (input) => state.addInboundMessage(input),
        addOutboundMessage: (input) => state.addOutboundMessage(input),
        editMessage: (input) => state.editMessage(input),
      },
      observedText: new Map(),
      sutUserId: "U123",
    });

    expect(state.getSnapshot().messages.at(-1)).toMatchObject({
      direction: "outbound",
      text: "thread reply",
      threadId: root.id,
    });
  });
});

describe("Slack agent E2E request settlement", () => {
  it("retains uncertain final Gateway writes while cleaning only known-owned receipts", async () => {
    const capturedEvents: Array<Record<string, unknown>> = [];
    const f = await nativeAdapterFixture(() => undefined, capturedEvents);
    const owned = await f.driver.send({ text: "owned root" });
    capturedEvents.push({
      id: 1,
      flowId: "unknown-post",
      host: "slack.com",
      kind: "request",
      method: "POST",
      path: "/api/chat.postMessage",
      dataText: new URLSearchParams({
        channel: "C123",
        thread_ts: owned.id,
        text: "unconfirmed SUT reply",
      }).toString(),
    });
    await f.adapter.cleanup?.();
    await expect(f.adapter.captureBeforeGatewayCleanup?.()).rejects.toThrow(
      "final capture is incomplete",
    );
    capturedEvents.length = 0;
    await expect(f.adapter.cleanupAfterGatewayStop?.()).rejects.toThrow(
      "preserve private evidence",
    );
    expect((await f.artifact()).evidence).toContainEqual(
      expect.objectContaining({
        operation: "Gateway chat.postMessage",
        outcome: "uncertain",
        requestEventId: 1,
        threadId: owned.id,
        detail: "response-not-captured",
      }),
    );
    expect(
      f.requests
        .filter((request) => request.method === "chat.delete")
        .map((request) => request.body.get("ts")),
    ).toEqual([owned.id]);
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
          : expect(cleaning).rejects.toThrow("preserve private evidence");
      f.expire(signal);
      await rejected;
      await cleaned;

      expect(f.requests.slice(baseline).map((request) => request.method)).toEqual(
        operation === "upload" ? ["files.getUploadURLExternal", "upload-data"] : [method],
      );
      const artifact = await f.artifact();
      expect(artifact.ownedMessages).toEqual([]);
      expect(artifact.ownedFileIds).toEqual([]);
      if (operation !== "read") {
        expect(artifact.evidence).toContainEqual(
          expect.objectContaining({
            operation: operation === "send" ? "chat.postMessage" : "files.uploadV2",
            outcome: "uncertain",
          }),
        );
      }
      expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
      expect(mocks.credentialRelease).toHaveBeenCalledOnce();
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
    const cleaned = expect(f.cleanup()).rejects.toThrow("preserve private evidence");
    const signal = await response.started;
    f.expire(signal);
    await cleaned;

    expect(
      f.requests
        .filter((request) => request.method === "chat.delete")
        .map((request) => request.body.get("ts")),
    ).toEqual([second.id, first.id]);
    const artifact = await f.artifact();
    expect(artifact.ownedMessages).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ id: first.id }),
        deleted: true,
      }),
      { message: expect.objectContaining({ id: second.id }) },
    ]);
    expect(artifact.evidence).toContainEqual(
      expect.objectContaining({
        operation: "cleanup chat.delete",
        messageId: second.id,
        outcome: "failed",
        detail: expect.stringContaining("without a definitive Slack receipt"),
      }),
    );
    expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
    expect(mocks.credentialRelease).toHaveBeenCalledOnce();
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

    expect(f.requests.filter((request) => request.method === "chat.postMessage")).toHaveLength(1);
    expect(
      f.requests
        .filter((request) => request.method === "chat.delete")
        .map((request) => request.body.get("ts")),
    ).toEqual(["7.000000"]);
    expect((await f.artifact()).ownedMessages).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ id: "7.000000" }),
        deleted: true,
      }),
    ]);
    expect(mocks.credentialRelease).toHaveBeenCalledOnce();
  });

  it("does not wait or replay a native write refused with a long Retry-After", async () => {
    const f = await nativeAdapterFixture((method) =>
      method === "chat.postMessage"
        ? new Response("rate limited", { status: 429, headers: { "retry-after": "86400" } })
        : undefined,
    );
    await expect(f.driver.send({ text: "refused write" })).rejects.toThrow(
      "without a definitive Slack receipt",
    );
    await expect(f.cleanup()).rejects.toThrow("preserve private evidence");
    expect(f.requests.filter((request) => request.method === "chat.postMessage")).toHaveLength(1);
    expect(f.requests.filter((request) => request.method === "chat.delete")).toEqual([]);
    expect(mocks.credentialRelease).toHaveBeenCalledOnce();
  });
});
