import { AsyncLocalStorage } from "node:async_hooks";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VoiceCallRuntime } from "./runtime-entry.js";

vi.mock("./runtime-entry.js", () => ({
  createVoiceCallRuntime: vi.fn(),
}));

import {
  createVoiceCallLogger as createLogger,
  registerVoiceCall,
  createVoiceCallServiceContext,
  type VoiceCallTestTool,
} from "./index.test-harness.js";
import { createVoiceCallRuntime } from "./runtime-entry.js";

type VoiceCallToolResult = Awaited<ReturnType<VoiceCallTestTool["execute"]>>;

const serviceHealth = {
  reportFailure: vi.fn(),
  clearFailure: vi.fn(),
};
const serviceContext = createVoiceCallServiceContext({ serviceHealth });

function createRuntime(callId: string, toNumber: string, stopImpl?: () => Promise<void>) {
  const initiateCall = vi.fn(async () => ({ callId, success: true }));
  const stop = vi.fn(stopImpl ?? (async () => {}));
  const runtime = {
    config: { toNumber, realtime: { enabled: false } },
    manager: { initiateCall },
    stop,
  } as unknown as VoiceCallRuntime;
  return { initiateCall, runtime, stop };
}

function mockRuntimePair(stopA?: () => Promise<void>) {
  const runtimeA = createRuntime("call-a", "+15550000001", stopA);
  const runtimeB = createRuntime("call-b", "+15550000002");
  vi.mocked(createVoiceCallRuntime)
    .mockResolvedValueOnce(runtimeA.runtime)
    .mockResolvedValueOnce(runtimeB.runtime);
  return { runtimeA, runtimeB };
}

function executeCall(tool: VoiceCallTestTool): Promise<VoiceCallToolResult> {
  return tool.execute("call", { action: "initiate_call", message: "hello" });
}

async function executeGatewayCall(registration: ReturnType<typeof registerVoiceCall>) {
  const respond = vi.fn();
  await registration.methods.get("voicecall.initiate")?.({
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

it("requires service startup before enabling requester reporting", async () => {
  const registration = registerVoiceCall({ config: { reports: { enabled: true } } });
  expectLifecycleError(await executeCall(registration.tool()), "requires service startup");
  expect(createVoiceCallRuntime).not.toHaveBeenCalled();
});

it("captures each replacement service context independently of the requesting caller", async () => {
  const actor = new AsyncLocalStorage<string>();
  const { runtimeA } = mockRuntimePair();
  const readContext = (context: typeof contextA) =>
    actor.run("requesting-caller", () => context?.(() => actor.getStore()));
  const serviceA = registerVoiceCall({ config: { reports: { enabled: true } } });
  void actor.run("service-a", () => serviceA.service.start(serviceContext));
  await actor.run("requesting-caller", () => executeCall(serviceA.tool()));
  const contextA = vi.mocked(createVoiceCallRuntime).mock.calls[0]?.[0].runInServiceContext;
  expect(contextA).toBeDefined();
  expect(readContext(contextA)).toBe("service-a");

  const serviceB = registerVoiceCall({ config: { reports: { enabled: true } } });
  void actor.run("service-b", () => serviceB.service.start(serviceContext));
  await actor.run("requesting-caller", () => executeCall(serviceB.tool()));
  const contextB = vi.mocked(createVoiceCallRuntime).mock.calls[1]?.[0].runInServiceContext;
  expect(readContext(contextB)).toBe("service-b");
  expect(readContext(contextA)).toBe("service-a");
  expect(runtimeA.stop).toHaveBeenCalledOnce();
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

it("keeps the service runtime after a tool-discovery consult registration fails and is cleaned up", async () => {
  const fixture = createRuntime("call-a", "+15550000001");
  vi.mocked(createVoiceCallRuntime).mockResolvedValue(fixture.runtime);
  const service = registerVoiceCall({});
  void service.service.start(serviceContext);
  await executeCall(service.tool());
  const consult = registerVoiceCall({ registrationMode: "tool-discovery" });
  fixture.initiateCall.mockRejectedValueOnce(
    new Error("agent harness host capability is no longer active"),
  );

  expectLifecycleError(await executeCall(consult.tool()), "host capability is no longer active");
  await consult.service.stop?.(serviceContext);
  const respond = await executeGatewayCall(service);

  expect(respond).toHaveBeenCalledWith(true, { callId: "call-a", initiated: true });
  expect(fixture.stop).not.toHaveBeenCalled();
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
  const { runtimeA, runtimeB } = mockRuntimePair();
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
  const { runtimeA, runtimeB } = mockRuntimePair(() => {
    aStopEntered.resolve();
    return releaseAStop.promise;
  });
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
  expect(vi.mocked(createVoiceCallRuntime).mock.calls[1]?.[0].config.toNumber).toBe("+15550000002");
  expect(runtimeB.initiateCall).toHaveBeenCalledTimes(1);
});

it("routes retained concrete and cold-registry tools to the current service", async () => {
  const { runtimeA, runtimeB } = mockRuntimePair();
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
