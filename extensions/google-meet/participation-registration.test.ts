import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import type { GoogleMeetRuntime } from "./src/runtime.js";
import {
  createGoogleMeetToolGatewayForTest,
  invokeGoogleMeetGatewayMethodForTest,
  setupGoogleMeetPlugin,
} from "./src/test-support/plugin-harness.js";
import { testing } from "./test-api.js";

const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");

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
    const { tool } = setup();

    expect(tool.description).toContain("recover_current_tab");
    expect(JSON.stringify(tool.parameters)).not.toContain("anyOf");
    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: {
        action: { type: "string", description: expect.stringContaining("recover_current_tab") },
        transport: { type: "string" },
        mode: { type: "string" },
      },
    });
  });

  it("advertises only the googlemeet CLI descriptor", () => {
    const { cliRegistrations } = setup();

    expect(cliRegistrations).toEqual([
      {
        commands: ["googlemeet"],
        descriptors: [
          {
            name: "googlemeet",
            description: "Join and manage Google Meet calls",
            hasSubcommands: true,
            machineOutput: expect.any(Function),
          },
        ],
      },
    ]);
  });

  it("registers the node-host command used by chrome-node transport", () => {
    const { nodeHostCommands, nodeInvokePolicies } = setup();

    const command = nodeHostCommands.find(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) && entry.command === "googlemeet.chrome",
    );
    if (!command) {
      throw new Error("expected googlemeet.chrome node host command");
    }
    expect(command.cap).toBe("google-meet");
    expect(command.dangerous).toBe(true);
    expect(typeof command.handle).toBe("function");
    expect(nodeInvokePolicies).toHaveLength(1);
    expect(nodeInvokePolicies[0]).toMatchObject({
      commands: ["googlemeet.chrome"],
      dangerous: true,
    });
  });

  it("exposes native chat on the provider-safe flat tool schema", () => {
    const { tool } = setup();
    const parameters = requireRecord(tool.parameters, "Google Meet tool parameters");
    const properties = requireRecord(
      parameters.properties,
      "Google Meet tool parameter properties",
    );
    const action = requireRecord(properties.action, "Google Meet action parameter");

    expect(parameters.type).toBe("object");
    expect(JSON.stringify(tool.parameters)).not.toContain("anyOf");
    expect(action.enum).toContain("send_chat");
    expect(properties.text).toMatchObject({ type: "string" });
    expect(properties.output).toMatchObject({ type: "string", enum: ["chat", "voice"] });
  });

  it.each([
    { text: "Send in chat.", expected: true },
    { text: "Send in chat.", output: "chat", expected: true },
    { text: "Reply aloud.", output: "voice", expected: true },
    { text: "Never send both.", output: "both", expected: false },
    { text: 123, expected: false },
  ])("validates send_chat tool parameters: %j", ({ expected, ...message }) => {
    const { tool } = setup();
    const result = validateJsonSchemaValue({
      schema: tool.parameters as JsonSchemaObject,
      cacheKey: "google-meet.tool.send-chat",
      value: {
        action: "send_chat",
        sessionId: "meet_1",
        requestId: "request-1",
        ...message,
      },
    });
    expect(result.ok).toBe(expected);
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
