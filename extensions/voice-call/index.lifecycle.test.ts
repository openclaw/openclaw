import os from "node:os";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { OpenClawPluginServiceContextV2 } from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import type { VoiceCallRuntime } from "./runtime-entry.js";
import { VoiceCallConfigSchema } from "./src/config.js";
import { CallManager } from "./src/manager.js";
import type { CallRecord } from "./src/types.js";

vi.mock("./runtime-entry.js", () => ({
  createVoiceCallRuntime: vi.fn(),
}));

import plugin from "./index.js";
import { createVoiceCallRuntime } from "./runtime-entry.js";
import {
  createVoiceCallStateRuntimeForTests,
  FakeProvider,
  registerTestManagerCleanup,
} from "./src/manager.test-harness.js";
import { speak as speakWithContext } from "./src/manager/outbound.js";
import type { VoiceCallStateRuntime } from "./src/runtime-state.js";

// These names are persisted storage contracts, independent of private store declarations.
const CALL_RECORD_EVENTS_NAMESPACE = "call-record-events";

type VoiceCallService = Parameters<OpenClawPluginApi["registerService"]>[0];
type VoiceCallGatewayHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
type VoiceCallTool = {
  execute: (toolCallId: string, params: unknown) => Promise<VoiceCallToolResult>;
};
type VoiceCallToolFactory = (context: Record<string, unknown>) => VoiceCallTool;
type VoiceCallToolResult = {
  content?: Array<{ text?: string }>;
  details?: { error?: unknown };
};

type RuntimeFixture = {
  initiateCall: ReturnType<typeof vi.fn>;
  runtime: VoiceCallRuntime;
  sendDtmf: ReturnType<typeof vi.fn>;
  speak: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

const serviceHealth = {
  reportFailure: vi.fn(),
  clearFailure: vi.fn(),
};
const serviceContext = {
  config: {},
  stateDir: os.tmpdir(),
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  serviceHealth,
  scheduler: createTestPluginServiceScheduler(),
} satisfies OpenClawPluginServiceContextV2;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createLogger(onError?: (message: string) => void) {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn((message: string) => onError?.(message)),
    debug: vi.fn(),
  };
}

function createRuntime(
  callId: string,
  toNumber: string,
  stopImpl?: () => Promise<void>,
  provider = "mock",
) {
  const initiateCall = vi.fn(async () => ({ callId, success: true }));
  const sendDtmf = vi.fn(async () => ({ success: true }));
  const speak = vi.fn(async () => ({ success: true }));
  const stop = vi.fn(stopImpl ?? (async () => {}));
  const runtime = {
    config: { provider, toNumber, realtime: { enabled: false } },
    manager: {
      initiateCall,
      sendDtmf,
      speak,
      getCall: vi.fn(() => undefined),
      getCallByProviderCallId: vi.fn(() => undefined),
      getCallFromMemoryOrStore: vi.fn(async () => undefined),
    },
    webhookServer: {
      speakRealtime: vi.fn(() => ({ success: false, error: "No active realtime bridge" })),
    },
    stop,
  } as unknown as VoiceCallRuntime;
  return { initiateCall, runtime, sendDtmf, speak, stop } satisfies RuntimeFixture;
}

function registerVoiceCall(params: {
  config?: Record<string, unknown>;
  logger?: ReturnType<typeof createLogger>;
  registrationMode?: OpenClawPluginApi["registrationMode"];
}) {
  let service: VoiceCallService | undefined;
  let toolFactory: VoiceCallToolFactory | undefined;
  const gatewayHandlers = new Map<string, VoiceCallGatewayHandler>();
  const api = createTestPluginApi({
    id: "voice-call",
    name: "Voice Call",
    description: "test",
    version: "0",
    source: "test",
    registrationMode: params.registrationMode ?? "full",
    config: {},
    pluginConfig: { provider: "mock", ...params.config },
    runtime: { tts: { textToSpeechTelephony: vi.fn() } } as unknown as OpenClawPluginApi["runtime"],
    logger: params.logger ?? createLogger(),
    registerGatewayMethod: (method, handler) => {
      gatewayHandlers.set(method, handler);
    },
    registerTool: (registration) => {
      toolFactory =
        typeof registration === "function"
          ? (registration as unknown as VoiceCallToolFactory)
          : () => registration as unknown as VoiceCallTool;
    },
    registerCli: () => {},
    registerService: (registeredService) => {
      service = registeredService;
    },
    resolvePath: (value) => value,
  });
  plugin.register(api);
  if (!service || !toolFactory) {
    throw new Error("expected voice-call service and tool registrations");
  }
  const registeredToolFactory = toolFactory;
  return {
    gatewayHandlers,
    service,
    toolFactory: registeredToolFactory,
    tool: () => registeredToolFactory({}),
  };
}

function executeCall(tool: VoiceCallTool): Promise<VoiceCallToolResult> {
  return tool.execute("call", { action: "initiate_call", message: "hello" });
}

async function executeGatewayCall(registration: ReturnType<typeof registerVoiceCall>) {
  return await executeGatewayCommand(registration, "voicecall.initiate", { message: "hello" });
}

async function executeGatewayCommand(
  registration: ReturnType<typeof registerVoiceCall>,
  method: string,
  params: Record<string, unknown>,
) {
  const respond = vi.fn();
  await registration.gatewayHandlers.get(method)?.({
    params,
    respond,
  } as never);
  return respond;
}

function expectLifecycleError(result: VoiceCallToolResult, text: string): void {
  const detail = result.details?.error;
  const error = typeof detail === "string" ? detail : JSON.stringify(detail ?? "");
  expect(error).toContain(text);
  expect(result.content?.some((entry) => entry.text?.includes(error))).toBe(true);
}

describe("voice-call runtime lifecycle", () => {
  beforeEach(() => {
    vi.mocked(createVoiceCallRuntime).mockReset();
    serviceHealth.reportFailure.mockReset();
    serviceHealth.clearFailure.mockReset();
  });

  afterEach(() => {
    delete (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.voice-call.runtimeCoordinator")
    ];
    vi.restoreAllMocks();
  });

  it("shares one pending runtime between full and tool-discovery registrations", async () => {
    const runtimeReady = createDeferred<VoiceCallRuntime>();
    const fixture = createRuntime("call-a", "+15550000001");
    vi.mocked(createVoiceCallRuntime).mockReturnValue(runtimeReady.promise);
    const full = registerVoiceCall({ registrationMode: "full" });

    expect(full.service.start(serviceContext)).toBeUndefined();
    const discovery = registerVoiceCall({ registrationMode: "tool-discovery" });
    const fullCall = executeCall(full.tool());
    const discoveryCall = executeCall(discovery.tool());
    expect(createVoiceCallRuntime).toHaveBeenCalledTimes(1);

    runtimeReady.resolve(fixture.runtime);
    await Promise.all([fullCall, discoveryCall]);

    expect(fixture.initiateCall).toHaveBeenCalledTimes(2);
    expect(createVoiceCallRuntime).toHaveBeenCalledTimes(1);
  });

  it("retires a pending generation and stops its late runtime once", async () => {
    const runtimeReady = createDeferred<VoiceCallRuntime>();
    const fixture = createRuntime("call-a", "+15550000001");
    const logger = createLogger();
    vi.mocked(createVoiceCallRuntime).mockReturnValue(runtimeReady.promise);
    const generationA = registerVoiceCall({ logger });

    expect(generationA.service.start(serviceContext)).toBeUndefined();
    const firstStop = generationA.service.stop?.(serviceContext);
    const secondStop = generationA.service.stop?.(serviceContext);
    runtimeReady.resolve(fixture.runtime);
    await Promise.all([firstStop, secondStop]);

    expect(createVoiceCallRuntime).toHaveBeenCalledTimes(1);
    expect(fixture.stop).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expectLifecycleError(await executeCall(generationA.tool()), "retired");
    expect(createVoiceCallRuntime).toHaveBeenCalledTimes(1);
  });

  it("restarts tools and gateway commands on the same service registration", async () => {
    const runtimeA = createRuntime("call-a", "+15550000001");
    const runtimeB = createRuntime("call-b", "+15550000002");
    vi.mocked(createVoiceCallRuntime)
      .mockResolvedValueOnce(runtimeA.runtime)
      .mockResolvedValueOnce(runtimeB.runtime);
    const registration = registerVoiceCall({});
    const retainedTool = registration.tool();

    expect(registration.service.start(serviceContext)).toBeUndefined();
    await executeCall(retainedTool);
    await registration.service.stop?.(serviceContext);
    expect(registration.service.start(serviceContext)).toBeUndefined();

    await executeCall(retainedTool);
    const respond = await executeGatewayCall(registration);

    expect(respond).toHaveBeenCalledWith(true, { callId: "call-b", initiated: true });
    expect(createVoiceCallRuntime).toHaveBeenCalledTimes(2);
    expect(runtimeA.stop).toHaveBeenCalledTimes(1);
    expect(runtimeB.initiateCall).toHaveBeenCalledTimes(2);
  });

  it("rejects a disabled registration before reusing the predecessor's live runtime", async () => {
    const runtimeA = createRuntime("call-a", "+15550000001");
    vi.mocked(createVoiceCallRuntime).mockResolvedValue(runtimeA.runtime);
    const generationA = registerVoiceCall({ registrationMode: "full" });
    expect(generationA.service.start(serviceContext)).toBeUndefined();
    await executeCall(generationA.tool());
    expect(runtimeA.initiateCall).toHaveBeenCalledTimes(1);

    const disabledB = registerVoiceCall({ config: { enabled: false }, registrationMode: "full" });
    const respond = await executeGatewayCall(disabledB);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("disabled") }),
    );
    // The predecessor's runtime manager must not have received a second call attempt.
    expect(runtimeA.initiateCall).toHaveBeenCalledTimes(1);
    expect(createVoiceCallRuntime).toHaveBeenCalledTimes(1);
  });

  it("rejects superseded retained handlers before call I/O and after an awaited lookup", async () => {
    const historicalLookupEntered = createDeferred<void>();
    const historicalCallReady = createDeferred<CallRecord | undefined>();
    const runtimeA = createRuntime("call-a", "+15550000001");
    runtimeA.runtime.manager.getCallFromMemoryOrStore = vi.fn(() => {
      historicalLookupEntered.resolve();
      return historicalCallReady.promise;
    });
    vi.mocked(createVoiceCallRuntime).mockResolvedValue(runtimeA.runtime);
    const generationA = registerVoiceCall({ registrationMode: "full" });
    expect(generationA.service.start(serviceContext)).toBeUndefined();
    await executeCall(generationA.tool());

    const speakingA = executeGatewayCommand(generationA, "voicecall.speak", {
      callId: "call-a",
      message: "hello",
    });
    await historicalLookupEntered.promise;
    const generationB = registerVoiceCall({ registrationMode: "full" });
    const respondB = await executeGatewayCommand(generationB, "voicecall.dtmf", {
      callId: "call-a",
      digits: "1",
    });

    expect(respondB).toHaveBeenCalledWith(true, { success: true });
    expect(runtimeA.sendDtmf).toHaveBeenCalledTimes(1);

    const staleRespond = await executeGatewayCommand(generationA, "voicecall.dtmf", {
      callId: "call-a",
      digits: "2",
    });
    expect(staleRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("superseded") }),
    );
    expect(runtimeA.sendDtmf).toHaveBeenCalledTimes(1);

    historicalCallReady.resolve({
      callId: "call-a",
      provider: "mock",
      direction: "outbound",
      state: "active",
      from: "+15550000000",
      to: "+15550000001",
      startedAt: Date.UTC(2026, 8, 30, 12, 0, 0),
      transcript: [],
      processedEventIds: [],
    });
    const speakingRespond = await speakingA;
    expect(speakingRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("superseded") }),
    );
    expect(runtimeA.speak).not.toHaveBeenCalled();
  });

  it("fences borrowed-runtime playback when registration changes during the state write", async () => {
    const stateWriteEntered = createDeferred<void>();
    const releaseStateWrite = createDeferred<void>();
    const playTts = vi.fn(async () => {});
    let blockNextStoreWrite = true;
    const stateStore = {
      register: vi.fn(async () => {
        if (blockNextStoreWrite) {
          blockNextStoreWrite = false;
          stateWriteEntered.resolve();
          await releaseStateWrite.promise;
        }
      }),
      count: vi.fn(async () => 0),
    };
    const call: CallRecord = {
      callId: "call-a",
      providerCallId: "provider-a",
      provider: "mock",
      direction: "outbound",
      state: "active",
      from: "+15550000000",
      to: "+15550000001",
      startedAt: Date.UTC(2026, 8, 30, 12, 0, 0),
      transcript: [],
      processedEventIds: [],
    };
    const managerContext = {
      mutationQueue: new KeyedAsyncQueue(),
      activeCalls: new Map([[call.callId, call]]),
      providerCallIdMap: new Map([["provider-a", call.callId]]),
      provider: { name: "mock", playTts },
      config: { tts: { provider: "openai" } },
      storePath: "/tmp/voice-call-lifecycle-test",
      stateRuntime: { openKeyedStore: vi.fn(() => stateStore) },
      transcriptWaiters: new Map(),
      maxDurationTimers: new Map(),
      endCallOperations: new Map(),
      trackCallWork: vi.fn(),
      isStopping: () => false,
    };
    const runtimeA = createRuntime("call-a", "+15550000001");
    runtimeA.runtime.manager.getCall = vi.fn(() => call);
    runtimeA.runtime.manager.speak = vi.fn((callId, message, options) =>
      speakWithContext(managerContext as never, callId, message, options),
    );
    vi.mocked(createVoiceCallRuntime).mockResolvedValue(runtimeA.runtime);
    const generationA = registerVoiceCall({ registrationMode: "full" });
    expect(generationA.service.start(serviceContext)).toBeUndefined();
    await executeCall(generationA.tool());

    const generationB = registerVoiceCall({ registrationMode: "full" });
    const speakingB = executeGatewayCommand(generationB, "voicecall.speak", {
      callId: call.callId,
      message: "hello",
    });
    await stateWriteEntered.promise;

    const generationC = registerVoiceCall({ registrationMode: "full" });
    const respondC = await executeGatewayCommand(generationC, "voicecall.dtmf", {
      callId: call.callId,
      digits: "1",
    });
    expect(respondC).toHaveBeenCalledWith(true, { success: true });

    releaseStateWrite.resolve();
    const respondB = await speakingB;

    expect(playTts).not.toHaveBeenCalled();
    expect(respondB).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("superseded") }),
    );
  });

  it("fences borrowed-runtime dialing when registration changes during admission", async () => {
    const stateWriteEntered = createDeferred<void>();
    const releaseStateWrite = createDeferred<void>();
    const stateStores = new Map<string, Map<string, { value: unknown; createdAt: number }>>();
    let blockNextAdmissionWrite = false;
    const stateRuntime: VoiceCallStateRuntime["state"] = {
      ...createVoiceCallStateRuntimeForTests(),
      openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions): PluginStateKeyedStore<T> => {
        const records =
          stateStores.get(options.namespace) ??
          new Map<string, { value: unknown; createdAt: number }>();
        stateStores.set(options.namespace, records);
        return {
          async register(key: string, value: T) {
            if (options.namespace === CALL_RECORD_EVENTS_NAMESPACE && blockNextAdmissionWrite) {
              blockNextAdmissionWrite = false;
              stateWriteEntered.resolve();
              await releaseStateWrite.promise;
            }
            records.set(key, { value, createdAt: Date.now() });
          },
          async lookup(key: string) {
            return records.get(key)?.value as T | undefined;
          },
          async registerIfAbsent(key: string, value: T) {
            if (records.has(key)) {
              return false;
            }
            records.set(key, { value, createdAt: Date.now() });
            return true;
          },
          async consume(key: string) {
            const value = records.get(key)?.value as T | undefined;
            records.delete(key);
            return value;
          },
          async delete(key: string) {
            return records.delete(key);
          },
          async entries() {
            return [...records].map(([key, entry]) => ({
              key,
              value: entry.value as T,
              createdAt: entry.createdAt,
            }));
          },
          async count() {
            return records.size;
          },
          async clear() {
            records.clear();
          },
        };
      },
    };
    const provider = Object.assign(new FakeProvider(), {
      sendDtmf: vi.fn(async () => {}),
    });
    const dial = vi.spyOn(provider, "initiateCall").mockImplementation(async (input) => ({
      providerCallId: `provider-${input.callId}`,
      status: "initiated",
    }));
    const config = VoiceCallConfigSchema.parse({
      provider: "plivo",
      fromNumber: "+15550000000",
      maxConcurrentCalls: 2,
    });
    const manager = registerTestManagerCleanup(
      new CallManager(
        config,
        tempDirs.make("openclaw-voice-call-lifecycle-"),
        undefined,
        stateRuntime,
      ),
    );
    await manager.initialize(provider, "https://example.com/voice/webhook");
    const liveCall = await manager.initiateCall("+15550000001");
    expect(liveCall.success).toBe(true);

    const runtime = createRuntime("unused", "+15550000002");
    runtime.runtime.manager = manager;
    vi.mocked(createVoiceCallRuntime).mockResolvedValue(runtime.runtime);
    const generationB = registerVoiceCall({ registrationMode: "full" });
    expect(generationB.service.start(serviceContext)).toBeUndefined();
    blockNextAdmissionWrite = true;
    const dialingB = executeGatewayCommand(generationB, "voicecall.initiate", {
      to: "+15550000002",
      message: "hello",
    });
    await stateWriteEntered.promise;

    const generationC = registerVoiceCall({ registrationMode: "full" });
    const respondC = await executeGatewayCommand(generationC, "voicecall.dtmf", {
      callId: liveCall.callId,
      digits: "1",
    });
    expect(respondC).toHaveBeenCalledWith(true, { success: true });

    releaseStateWrite.resolve();
    const respondB = await dialingB;

    expect(dial).toHaveBeenCalledTimes(1);
    expect(dial).not.toHaveBeenCalledWith(expect.objectContaining({ to: "+15550000002" }));
    expect(respondB).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("superseded") }),
    );
    expect(manager.getActiveCalls().map((call) => call.callId)).toEqual([liveCall.callId]);
    const rejectedRecords = (await manager.getCallHistory()).filter(
      (call) => call.callId !== liveCall.callId,
    );
    expect(rejectedRecords.at(-1)).toMatchObject({ state: "failed", endReason: "failed" });
  });

  it("starts a new call with the current registration config after reload", async () => {
    const runtimeA = createRuntime("call-a", "+15550000001");
    const runtimeB = createRuntime("call-b", "+15550000002", undefined, "twilio");
    vi.mocked(createVoiceCallRuntime)
      .mockResolvedValueOnce(runtimeA.runtime)
      .mockResolvedValueOnce(runtimeB.runtime);
    const generationA = registerVoiceCall({
      config: { provider: "mock", toNumber: "+15550000001" },
      registrationMode: "full",
    });
    expect(generationA.service.start(serviceContext)).toBeUndefined();
    await executeCall(generationA.tool());
    const generationB = registerVoiceCall({
      config: {
        provider: "twilio",
        fromNumber: "+15550000003",
        toNumber: "+15550000002",
        twilio: { accountSid: "AC123", authToken: "test-token" },
      },
      registrationMode: "full",
    });
    expect(generationB.service.start(serviceContext)).toBeUndefined();

    const respond = await executeGatewayCall(generationB);

    expect(respond).toHaveBeenCalledWith(true, { callId: "call-b", initiated: true });
    expect(runtimeA.stop).toHaveBeenCalledTimes(1);
    expect(runtimeA.initiateCall).toHaveBeenCalledTimes(1);
    expect(runtimeB.initiateCall).toHaveBeenCalledWith(
      "+15550000002",
      undefined,
      {
        message: "hello",
        mode: undefined,
        dtmfSequence: undefined,
      },
      { isCurrent: expect.any(Function) },
    );
    expect(vi.mocked(createVoiceCallRuntime).mock.calls[1]?.[0].config).toMatchObject({
      provider: "twilio",
      toNumber: "+15550000002",
    });
  });

  it("waits for A stopping before creating B with B config", async () => {
    const aStopEntered = createDeferred<void>();
    const releaseAStop = createDeferred<void>();
    const runtimeA = createRuntime("call-a", "+15550000001", () => {
      aStopEntered.resolve();
      return releaseAStop.promise;
    });
    const runtimeB = createRuntime("call-b", "+15550000002");
    vi.mocked(createVoiceCallRuntime)
      .mockResolvedValueOnce(runtimeA.runtime)
      .mockResolvedValueOnce(runtimeB.runtime);
    const generationA = registerVoiceCall({ config: { toNumber: "+15550000001" } });
    expect(generationA.service.start(serviceContext)).toBeUndefined();
    await executeCall(generationA.tool());
    const generationB = registerVoiceCall({ config: { toNumber: "+15550000002" } });

    const stoppingA = generationA.service.stop?.(serviceContext);
    expect(generationB.service.start(serviceContext)).toBeUndefined();
    const callB = executeCall(generationB.tool());
    await aStopEntered.promise;
    expect(runtimeA.stop).toHaveBeenCalledTimes(1);
    expect(createVoiceCallRuntime).toHaveBeenCalledTimes(1);

    releaseAStop.resolve();
    await Promise.all([stoppingA, callB]);

    expect(createVoiceCallRuntime).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createVoiceCallRuntime).mock.calls[1]?.[0].config.toNumber).toBe(
      "+15550000002",
    );
    expect(runtimeB.initiateCall).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale A stop clear or stop running B", async () => {
    const runtimeB = createRuntime("call-b", "+15550000002");
    vi.mocked(createVoiceCallRuntime).mockResolvedValue(runtimeB.runtime);
    const generationA = registerVoiceCall({ config: { toNumber: "+15550000001" } });
    const generationB = registerVoiceCall({ config: { toNumber: "+15550000002" } });

    expect(generationB.service.start(serviceContext)).toBeUndefined();
    await executeCall(generationB.tool());
    await generationA.service.stop?.(serviceContext);
    await executeCall(generationB.tool());

    expect(createVoiceCallRuntime).toHaveBeenCalledTimes(1);
    expect(runtimeB.initiateCall).toHaveBeenCalledTimes(2);
    expect(runtimeB.stop).not.toHaveBeenCalled();
  });

  it("rejects retained concrete and cold-registry A tools once B activates", async () => {
    const runtimeA = createRuntime("call-a", "+15550000001");
    const runtimeB = createRuntime("call-b", "+15550000002");
    vi.mocked(createVoiceCallRuntime)
      .mockResolvedValueOnce(runtimeA.runtime)
      .mockResolvedValueOnce(runtimeB.runtime);
    const generationA = registerVoiceCall({ registrationMode: "full" });
    const concreteToolA = generationA.tool();
    expect(generationA.service.start(serviceContext)).toBeUndefined();
    await executeCall(concreteToolA);
    const coldRegistryA = registerVoiceCall({ registrationMode: "tool-discovery" });
    const coldToolA = coldRegistryA.toolFactory({});
    const generationB = registerVoiceCall({ registrationMode: "full" });

    await executeCall(concreteToolA);
    await executeCall(coldToolA);
    expect(createVoiceCallRuntime).toHaveBeenCalledTimes(1);
    expect(runtimeA.initiateCall).toHaveBeenCalledTimes(3);

    expect(generationB.service.start(serviceContext)).toBeUndefined();
    expectLifecycleError(await executeCall(concreteToolA), "superseded");
    expectLifecycleError(await executeCall(coldToolA), "superseded");
    await generationA.service.stop?.(serviceContext);
    await executeCall(generationB.tool());
    await generationB.service.stop?.(serviceContext);
    expectLifecycleError(await executeCall(concreteToolA), "superseded");
    expectLifecycleError(await executeCall(coldToolA), "superseded");

    expect(createVoiceCallRuntime).toHaveBeenCalledTimes(2);
    expect(runtimeA.stop).toHaveBeenCalledTimes(1);
    expect(runtimeB.initiateCall).toHaveBeenCalledTimes(1);
    expect(runtimeB.stop).toHaveBeenCalledTimes(1);
  });

  it("does not revive an older staged A after activated B stops", async () => {
    const logged = createDeferred<string>();
    const runtimeB = createRuntime("call-b", "+15550000002");
    vi.mocked(createVoiceCallRuntime).mockResolvedValue(runtimeB.runtime);
    const stagedA = registerVoiceCall({
      logger: createLogger(logged.resolve),
      registrationMode: "full",
    });
    const retainedToolA = stagedA.tool();
    const generationB = registerVoiceCall({ registrationMode: "full" });

    expect(generationB.service.start(serviceContext)).toBeUndefined();
    await executeCall(generationB.tool());
    await generationB.service.stop?.(serviceContext);
    expectLifecycleError(await executeCall(retainedToolA), "superseded");
    expect(stagedA.service.start(serviceContext)).toBeUndefined();
    await expect(logged.promise).resolves.toContain("superseded");
    expect(serviceHealth.reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("superseded") }),
    );

    expect(createVoiceCallRuntime).toHaveBeenCalledTimes(1);
    expect(runtimeB.stop).toHaveBeenCalledTimes(1);
  });

  it("takes over a running slot owned by a retired predecessor", async () => {
    const runtimeA = createRuntime("call-a", "+15550000001");
    const runtimeB = createRuntime("call-b", "+15550000002");
    vi.mocked(createVoiceCallRuntime)
      .mockResolvedValueOnce(runtimeA.runtime)
      .mockResolvedValueOnce(runtimeB.runtime);
    const generationA = registerVoiceCall({});
    expect(generationA.service.start(serviceContext)).toBeUndefined();
    await executeCall(generationA.tool());
    const generationB = registerVoiceCall({});

    expect(generationB.service.start(serviceContext)).toBeUndefined();
    await executeCall(generationB.tool());

    expect(runtimeA.stop).toHaveBeenCalledTimes(1);
    expect(runtimeB.initiateCall).toHaveBeenCalledTimes(1);
    await generationB.service.stop?.(serviceContext);
  });

  it("logs a genuine startup failure and retries the same generation", async () => {
    const logged = createDeferred<string>();
    const runtimeA = createRuntime("call-a", "+15550000001");
    vi.mocked(createVoiceCallRuntime)
      .mockRejectedValueOnce(new Error("provider boom"))
      .mockResolvedValueOnce(runtimeA.runtime);
    const generationA = registerVoiceCall({ logger: createLogger(logged.resolve) });

    expect(generationA.service.start(serviceContext)).toBeUndefined();
    await expect(logged.promise).resolves.toContain("Failed to start runtime: provider boom");
    expect(serviceHealth.reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: "provider boom" }),
    );

    await executeCall(generationA.tool());
    expect(createVoiceCallRuntime).toHaveBeenCalledTimes(2);
    expect(runtimeA.initiateCall).toHaveBeenCalledTimes(1);
    expect(serviceHealth.clearFailure).toHaveBeenCalled();
  });
});
