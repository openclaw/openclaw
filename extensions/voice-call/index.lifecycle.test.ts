import os from "node:os";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginServiceContextV2 } from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import type { VoiceCallRuntime } from "./runtime-entry.js";

vi.mock("./runtime-entry.js", () => ({
  createVoiceCallRuntime: vi.fn(),
}));

import plugin from "./index.js";
import { createVoiceCallRuntime } from "./runtime-entry.js";

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

function createLogger(onError?: (message: string) => void) {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn((message: string) => onError?.(message)),
    debug: vi.fn(),
  };
}

function createRuntime(callId: string, toNumber: string, stopImpl?: () => Promise<void>) {
  const initiateCall = vi.fn(async () => ({ callId, success: true }));
  const stop = vi.fn(stopImpl ?? (async () => {}));
  const runtime = {
    config: { toNumber, realtime: { enabled: false } },
    manager: { initiateCall },
    stop,
  } as unknown as VoiceCallRuntime;
  return { initiateCall, runtime, stop } satisfies RuntimeFixture;
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
  const respond = vi.fn();
  await registration.gatewayHandlers.get("voicecall.initiate")?.({
    params: { message: "hello" },
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

  it.each(["full", "tool-discovery"] as const)(
    "keeps the service runtime after a %s consult registration fails and is cleaned up",
    async (registrationMode) => {
      const fixture = createRuntime("call-a", "+15550000001");
      vi.mocked(createVoiceCallRuntime).mockResolvedValue(fixture.runtime);
      const service = registerVoiceCall({});
      void service.service.start(serviceContext);
      await executeCall(service.tool());
      const consult = registerVoiceCall({ registrationMode });
      fixture.initiateCall.mockRejectedValueOnce(
        new Error("agent harness host capability is no longer active"),
      );

      expectLifecycleError(
        await executeCall(consult.tool()),
        "host capability is no longer active",
      );
      await consult.service.stop?.(serviceContext);
      const respond = await executeGatewayCall(service);

      expect(respond).toHaveBeenCalledWith(true, { callId: "call-a", initiated: true });
      expect(fixture.stop).not.toHaveBeenCalled();
      expect(createVoiceCallRuntime).toHaveBeenCalledTimes(1);
    },
  );

  it("routes retained gateway methods to the replacement service configuration", async () => {
    const runtimeA = createRuntime("call-a", "+15550000001");
    const runtimeB = createRuntime("call-b", "+15550000002");
    vi.mocked(createVoiceCallRuntime)
      .mockResolvedValueOnce(runtimeA.runtime)
      .mockResolvedValueOnce(runtimeB.runtime);
    const serviceA = registerVoiceCall({ config: { toNumber: "+15550000001" } });
    void serviceA.service.start(serviceContext);
    await executeCall(serviceA.tool());
    const serviceB = registerVoiceCall({ config: { toNumber: "+15550000002" } });
    void serviceB.service.start(serviceContext);
    const respond = await executeGatewayCall(serviceA);

    expect(respond).toHaveBeenCalledWith(true, { callId: "call-b", initiated: true });
    expect(vi.mocked(createVoiceCallRuntime).mock.calls[1]?.[0].config.toNumber).toBe(
      "+15550000002",
    );
    expect(runtimeA.stop).toHaveBeenCalledTimes(1);
    expect(runtimeB.stop).not.toHaveBeenCalled();
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

  it("routes retained concrete and cold-registry tools to the current service", async () => {
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
    await executeCall(concreteToolA);
    await executeCall(coldToolA);
    await generationA.service.stop?.(serviceContext);
    await executeCall(generationB.tool());
    await generationB.service.stop?.(serviceContext);
    expectLifecycleError(await executeCall(concreteToolA), "retired");
    expectLifecycleError(await executeCall(coldToolA), "retired");

    expect(createVoiceCallRuntime).toHaveBeenCalledTimes(2);
    expect(runtimeA.stop).toHaveBeenCalledTimes(1);
    expect(runtimeB.initiateCall).toHaveBeenCalledTimes(3);
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
    expectLifecycleError(await executeCall(retainedToolA), "retired");
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
