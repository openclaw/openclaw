import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as gatewayRuntime from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
import type { GoogleMeetRuntime } from "./src/runtime.js";
import { setupParticipationHarness } from "./src/test-support/participation-harness.js";
import { invokeGoogleMeetGatewayMethodForTest } from "./src/test-support/plugin-harness.js";

const runtime = vi.hoisted(() => ({
  constructed: vi.fn(),
  reconcileTranscriptPolicy: vi.fn<GoogleMeetRuntime["reconcileTranscriptPolicy"]>(),
  participate: vi.fn(),
  status: vi.fn(),
  leave: vi.fn(),
}));

vi.mock("./src/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/runtime.js")>()),
  GoogleMeetRuntime: class {
    constructor() {
      runtime.constructed();
    }
    reconcileTranscriptPolicy = runtime.reconcileTranscriptPolicy;
    participate = runtime.participate;
    status = runtime.status;
    leave = runtime.leave;
  },
}));

const request = {
  action: "participate",
  sessionId: "meeting-1",
  requestId: "request-1",
  participationAction: { type: "chat", text: "Hello" },
};
type GatewayHandler = (ctx: {
  params: Record<string, unknown>;
  respond: ReturnType<typeof vi.fn>;
}) => Promise<void>;

let harness: ReturnType<typeof setupParticipationHarness>;
beforeEach(() => {
  runtime.constructed.mockClear();
  runtime.reconcileTranscriptPolicy.mockReset().mockResolvedValue(undefined);
  runtime.participate.mockReset();
  runtime.status.mockReset();
  runtime.leave.mockReset();
  harness = setupParticipationHarness(plugin);
});
afterEach(() => vi.restoreAllMocks());

it("retries initial transcript policy on the original runtime after a gateway error", async () => {
  runtime.reconcileTranscriptPolicy.mockRejectedValueOnce(
    new Error("Transcript policy unavailable"),
  );
  const result = { requestId: request.requestId, status: "unsupported" };
  runtime.participate.mockResolvedValue(result);
  const participate = () =>
    invokeGoogleMeetGatewayMethodForTest(harness.methods, "googlemeet.participate", request);
  await expect(participate()).rejects.toThrow("Transcript policy unavailable");
  await expect(participate()).resolves.toEqual(result);
  expect(runtime.constructed).toHaveBeenCalledOnce();
  expect(runtime.reconcileTranscriptPolicy).toHaveBeenCalledTimes(2);
  expect(runtime.participate).toHaveBeenCalledOnce();
});

it("keeps gateway status and leave available during a later transcript policy failure", async () => {
  const services: OpenClawPluginService[] = [];
  const methods = new Map<string, unknown>();
  const api = createTestPluginApi({
    id: "google-meet",
    registerGatewayMethod: (method, handler) => methods.set(method, handler),
    registerService(service) {
      if (service.apiVersion === undefined || service.apiVersion === 1) {
        services.push(service);
      }
    },
  });
  plugin.register(api);
  const service = services[0];
  assert.ok(service?.stop);
  const status = () => invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.status");
  runtime.status.mockResolvedValue({ found: true });
  runtime.leave.mockResolvedValue({ found: true });
  await status();
  const gate = createDeferred<void>();
  runtime.reconcileTranscriptPolicy.mockImplementationOnce(() => gate.promise);
  const draining = service.stop({ config: {}, stateDir: "unused", logger: api.logger });
  const during = status();
  await setImmediate();
  const callsDuringDrain = runtime.status.mock.calls.length;
  gate.reject(new Error("Transcript drain failed"));
  const [read, drain] = await Promise.allSettled([during, draining]);
  expect(callsDuringDrain).toBe(2);
  expect(read).toMatchObject({ status: "fulfilled", value: { found: true } });
  expect(drain).toMatchObject({ status: "rejected", reason: new Error("Transcript drain failed") });
  await expect(
    invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.leave", {
      sessionId: "meeting-1",
    }),
  ).resolves.toEqual({ found: true });
  expect(runtime.reconcileTranscriptPolicy).toHaveBeenCalledTimes(2);
  expect(runtime.constructed).toHaveBeenCalledOnce();
});

it("returns structured gateway errors for missing session ids", async () => {
  for (const action of ["leave", "speak", "participationContext", "participate"]) {
    const handler = harness.methods.get(`googlemeet.${action}`) as GatewayHandler | undefined;
    const respond = vi.fn();
    await handler?.({ params: {}, respond });
    const payload = { error: "sessionId required" };
    expect(respond).toHaveBeenCalledWith(false, payload, {
      code: "INVALID_REQUEST",
      message: payload.error,
      details: payload,
    });
  }
});

it("passes action identity and correction references to the runtime once", async () => {
  const identity = { requestId: "request-2", sourceId: "source-1", correctionOf: "request-1" };
  const action = { type: "reaction", reaction: "👍" };
  const resultPayload = { requestId: "request-2", status: "unsupported" };
  runtime.participate.mockResolvedValue(resultPayload);
  expect(await harness.execute({ ...request, ...identity, participationAction: action })).toEqual(
    resultPayload,
  );
  expect(runtime.participate).toHaveBeenCalledExactlyOnceWith("meeting-1", { ...identity, action });
});

it.each([
  [{ requestId: undefined }, "requestId required"],
  [{ sourceId: 123 }, "sourceId must be a non-empty string"],
  [
    { participationAction: { type: "chat", text: 123 } },
    "participationAction.text must be a string",
  ],
])(
  "rejects malformed Gateway participation input before runtime dispatch: %j",
  async (overrides, message) => {
    const params = { ...request, ...overrides };
    await expect(
      invokeGoogleMeetGatewayMethodForTest(harness.methods, "googlemeet.participate", params),
    ).rejects.toThrow(message);
    expect(runtime.participate).not.toHaveBeenCalled();
  },
);

it("rejects malformed tool input before sending a Gateway request", async () => {
  const callGateway = vi.fn(async () => ({}));
  vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockImplementation(callGateway);

  const result = await harness.execute({ ...request, participationAction: "raise-hand" });

  expect(result).toEqual({ error: "participationAction.type required" });
  expect(callGateway).not.toHaveBeenCalled();
});

it("preserves runtime participation failures as structured tool results", async () => {
  runtime.participate.mockRejectedValue(new Error("Meeting session is no longer current"));
  expect(await harness.execute(request)).toEqual({
    error: "Meeting session is no longer current",
  });
});
