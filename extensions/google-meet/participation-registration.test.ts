import * as gatewayRuntime from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
import type { GoogleMeetRuntime } from "./src/runtime.js";
import { setupParticipationHarness } from "./src/test-support/participation-harness.js";
import { invokeGoogleMeetGatewayMethodForTest } from "./src/test-support/plugin-harness.js";

const runtime = vi.hoisted(() => ({
  reconcileTranscriptPolicy: vi.fn<GoogleMeetRuntime["reconcileTranscriptPolicy"]>(),
  participate: vi.fn(),
}));

vi.mock("./src/runtime.js", () => ({
  GoogleMeetRuntime: class {
    reconcileTranscriptPolicy = runtime.reconcileTranscriptPolicy;
    participate = runtime.participate;
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
  runtime.reconcileTranscriptPolicy.mockReset().mockResolvedValue(undefined);
  runtime.participate.mockReset();
  harness = setupParticipationHarness(plugin);
});
afterEach(() => vi.restoreAllMocks());

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
