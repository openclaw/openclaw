import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import type { GoogleMeetRuntime } from "./src/runtime.js";
import {
  createGoogleMeetToolGatewayForTest,
  getMeetTool,
  invokeGoogleMeetGatewayMethodForTest,
  setupGoogleMeetPlugin,
} from "./src/test-support/plugin-harness.js";
import { testing } from "./test-api.js";

const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");

const runtime = vi.hoisted(() => ({
  reconcileTranscriptPolicy: vi.fn<GoogleMeetRuntime["reconcileTranscriptPolicy"]>(),
  participationContext: vi.fn(),
  participate: vi.fn(),
}));

vi.mock("./src/runtime.js", () => ({
  GoogleMeetRuntime: class {
    reconcileTranscriptPolicy = runtime.reconcileTranscriptPolicy;
    participationContext = runtime.participationContext;
    participate = runtime.participate;
  },
}));

function setup() {
  const harness = setupGoogleMeetPlugin(plugin);
  testing.setCallGatewayFromCliForTests(createGoogleMeetToolGatewayForTest(harness.methods));
  const tool = harness.tools[0];
  if (!tool) {
    throw new Error("Expected Google Meet tool");
  }
  return { ...harness, tool };
}

describe("Google Meet participation and tool registration", () => {
  beforeEach(() => {
    runtime.reconcileTranscriptPolicy.mockReset().mockResolvedValue(undefined);
    runtime.participationContext.mockReset();
    runtime.participate.mockReset();
  });

  afterEach(() => {
    testing.setCallGatewayFromCliForTests();
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

  it("uses a provider-safe flat tool parameter schema", () => {
    const { tools } = setup();
    const tool = getMeetTool({ tools });

    expect(tool.description).toContain("recover_current_tab");
    expect(JSON.stringify(tool.parameters)).not.toContain("anyOf");
    const parameters = requireRecord(tool.parameters, "Google Meet tool parameters");
    expect(parameters.type).toBe("object");
    const properties = requireRecord(
      parameters.properties,
      "Google Meet tool parameter properties",
    );
    const action = requireRecord(properties.action, "Google Meet action parameter");
    expect(action.type).toBe("string");
    expect(action.enum).toEqual([
      "join",
      "create",
      "status",
      "transcript",
      "participation_context",
      "participate",
      "setup_status",
      "resolve_space",
      "preflight",
      "latest",
      "calendar_events",
      "artifacts",
      "attendance",
      "export",
      "recover_current_tab",
      "leave",
      "end_active_conference",
      "speak",
      "test_speech",
      "test_listen",
    ]);
    expect(action.description).toContain("recover_current_tab");
    expect(properties.transport).toEqual({
      type: "string",
      enum: ["chrome", "chrome-node", "twilio"],
      description: "Join transport",
    });
    expect(properties.mode).toEqual({
      type: "string",
      enum: ["agent", "bidi", "transcribe"],
      description:
        "Join mode. agent uses realtime transcription, the configured OpenClaw agent, and regular TTS. bidi uses the realtime voice model directly. transcribe joins observe-only.",
    });
  });

  it("routes participation context through the registered tool and Gateway", async () => {
    const context = {
      sessionId: "meeting-1",
      active: true,
      sourceOrder: 0,
      capabilities: [],
      sources: [],
    };
    runtime.participationContext.mockResolvedValue(context);
    const { tool } = setup();

    const result = await tool.execute("context-call", {
      action: "participation_context",
      sessionId: "meeting-1",
    });

    expect(result.details).toEqual(context);
    expect(runtime.reconcileTranscriptPolicy).toHaveBeenCalledOnce();
    expect(runtime.participationContext).toHaveBeenCalledExactlyOnceWith("meeting-1");
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
    [{ sessionId: undefined }, "sessionId required"],
    [{ requestId: undefined }, "requestId required"],
    [{ participationAction: undefined }, "participationAction.type required"],
    [{ participationAction: [] }, "participationAction.type required"],
    [{ participationAction: { type: " " } }, "participationAction.type required"],
    [{ sourceId: 123 }, "sourceId must be a non-empty string"],
    [{ correctionOf: " " }, "correctionOf must be a non-empty string"],
    [
      { participationAction: { type: "chat", text: 123 } },
      "participationAction.text must be a string",
    ],
    [
      { participationAction: { type: "reaction", reaction: false } },
      "participationAction.reaction must be a string",
    ],
  ])(
    "rejects malformed Gateway participation input before runtime dispatch: %j",
    async (overrides, message) => {
      const { methods } = setup();
      const params = {
        sessionId: "meeting-1",
        requestId: "request-1",
        participationAction: { type: "chat", text: "Hello" },
        ...overrides,
      };

      await expect(
        invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.participate", params),
      ).rejects.toThrow(message);
      expect(runtime.participate).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed tool input before sending a Gateway request", async () => {
    const { tool } = setup();
    const callGateway = vi.fn(async () => ({}));
    testing.setCallGatewayFromCliForTests(callGateway);

    const result = await tool.execute("invalid-call", {
      action: "participate",
      sessionId: "meeting-1",
      requestId: "request-1",
      participationAction: "raise-hand",
    });

    expect(result.details).toEqual({ error: "participationAction.type required" });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("preserves runtime participation failures as structured tool results", async () => {
    const { tool } = setup();
    runtime.participate.mockRejectedValue(new Error("Meeting session is no longer current"));

    const result = await tool.execute("stale-call", {
      action: "participate",
      sessionId: "meeting-1",
      requestId: "request-1",
      participationAction: { type: "chat", text: "Hello" },
    });

    expect(result.details).toEqual({ error: "Meeting session is no longer current" });
  });
});
