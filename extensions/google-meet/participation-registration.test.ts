import * as gatewayRuntime from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import type { GoogleMeetRuntime } from "./src/runtime.js";
import {
  createGoogleMeetToolGatewayForTest,
  invokeGoogleMeetGatewayMethodForTest,
  setupGoogleMeetPlugin,
} from "./src/test-support/plugin-harness.js";

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

function setup() {
  const harness = setupGoogleMeetPlugin(plugin);
  vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockImplementation(
    createGoogleMeetToolGatewayForTest(harness.methods),
  );
  const tool = harness.tools[0];
  if (!tool) {
    throw new Error("Expected Google Meet tool");
  }
  return { ...harness, tool };
}

describe("Google Meet participation and tool registration", () => {
  beforeEach(() => {
    runtime.reconcileTranscriptPolicy.mockReset().mockResolvedValue(undefined);
    runtime.participate.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns structured gateway errors for missing session ids", async () => {
    const { methods } = setup();
    for (const method of [
      "googlemeet.leave",
      "googlemeet.speak",
      "googlemeet.participationContext",
      "googlemeet.participate",
    ]) {
      const handler = methods.get(method) as
        | ((ctx: {
            params: Record<string, unknown>;
            respond: ReturnType<typeof vi.fn>;
          }) => Promise<void>)
        | undefined;
      const respond = vi.fn();

      await handler?.({ params: {}, respond });

      expect(respond).toHaveBeenCalledWith(
        false,
        { error: "sessionId required" },
        {
          code: "INVALID_REQUEST",
          message: "sessionId required",
          details: { error: "sessionId required" },
        },
      );
    }
  });

  it("passes action identity and correction references to the runtime once", async () => {
    const resultPayload = { requestId: "request-2", status: "unsupported" };
    runtime.participate.mockResolvedValue(resultPayload);
    const { tool } = setup();

    const result = await tool.execute("action-call", {
      action: "participate",
      sessionId: "meeting-1",
      requestId: "request-2",
      sourceId: "source-1",
      correctionOf: "request-1",
      participationAction: { type: "reaction", reaction: "👍" },
    });

    expect(result.details).toEqual(resultPayload);
    expect(runtime.participate).toHaveBeenCalledExactlyOnceWith("meeting-1", {
      requestId: "request-2",
      sourceId: "source-1",
      correctionOf: "request-1",
      action: { type: "reaction", reaction: "👍" },
    });
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
      const { methods } = setup();
      const params = { ...request, ...overrides };

      await expect(
        invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.participate", params),
      ).rejects.toThrow(message);
      expect(runtime.participate).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed tool input before sending a Gateway request", async () => {
    const { tool } = setup();
    const callGateway = vi.fn(async () => ({}));
    vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockImplementation(callGateway);

    const result = await tool.execute("invalid-call", {
      ...request,
      participationAction: "raise-hand",
    });

    expect(result.details).toEqual({ error: "participationAction.type required" });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("preserves runtime participation failures as structured tool results", async () => {
    const { tool } = setup();
    runtime.participate.mockRejectedValue(new Error("Meeting session is no longer current"));

    const result = await tool.execute("stale-call", request);

    expect(result.details).toEqual({ error: "Meeting session is no longer current" });
  });
});
