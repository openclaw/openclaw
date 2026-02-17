import { describe, expect, it } from "vitest";
import { buildEmbeddedRunPayloads, LastToolError } from "./payloads.js";

describe("buildEmbeddedRunPayloads", () => {
  it("includes tool error when isHeartbeat is false", () => {
    const lastToolError: LastToolError = {
      toolName: "someTool",
      error: "Some error",
      mutatingAction: true, // mutating action ensures it's shown
    };
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: ["HEARTBEAT_OK"],
      toolMetas: [],
      lastAssistant: {
        role: "assistant",
        content: [{ type: "text" as const, text: "HEARTBEAT_OK" }],
        stopReason: "stop",
      } as any,
      lastToolError,
      sessionKey: "test",
      inlineToolResultsAllowed: false,
      isHeartbeat: false,
    });

    const toolErrorPayload = payloads.find((p) => p.isError && p.text?.includes("failed"));
    expect(toolErrorPayload).toBeDefined();
    expect(toolErrorPayload?.text).toMatch(/someTool failed/i);
  });

  it("suppresses tool error when isHeartbeat is true and response contains HEARTBEAT_OK", () => {
    const lastToolError: LastToolError = {
      toolName: "someTool",
      error: "Some error",
      mutatingAction: true, // mutating action usually forces show, but heartbeat should suppress
    };
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: ["HEARTBEAT_OK"],
      toolMetas: [],
      lastAssistant: {
        role: "assistant",
        content: [{ type: "text" as const, text: "HEARTBEAT_OK" }],
        stopReason: "stop",
      } as any,
      lastToolError,
      sessionKey: "test",
      inlineToolResultsAllowed: false,
      isHeartbeat: true,
    });

    const toolErrorPayload = payloads.find((p) => p.isError && p.text?.includes("failed"));
    expect(toolErrorPayload).toBeUndefined();
  });

  it("includes tool error when isHeartbeat is true but response does NOT contain HEARTBEAT_OK", () => {
    const lastToolError: LastToolError = {
      toolName: "someTool",
      error: "Some error",
      mutatingAction: true,
    };
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: ["Something else"],
      toolMetas: [],
      lastAssistant: {
        role: "assistant",
        content: [{ type: "text" as const, text: "Something else" }],
        stopReason: "stop",
      } as any,
      lastToolError,
      sessionKey: "test",
      inlineToolResultsAllowed: false,
      isHeartbeat: true,
    });

    const toolErrorPayload = payloads.find((p) => p.isError && p.text?.includes("failed"));
    expect(toolErrorPayload).toBeDefined();
    expect(toolErrorPayload?.text).toMatch(/someTool failed/i);
  });

  it("suppresses non-mutating tool error when reply exists (standard behavior)", () => {
    const lastToolError: LastToolError = {
      toolName: "someTool",
      error: "Some error",
      mutatingAction: false,
    };
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: ["Some reply"],
      toolMetas: [],
      lastAssistant: {
        role: "assistant",
        content: [{ type: "text" as const, text: "Some reply" }],
        stopReason: "stop",
      } as any,
      lastToolError,
      sessionKey: "test",
      inlineToolResultsAllowed: false,
      isHeartbeat: false,
    });

    const toolErrorPayload = payloads.find((p) => p.isError && p.text?.includes("failed"));
    expect(toolErrorPayload).toBeUndefined();
  });

  it("includes mutating tool error when reply exists (standard behavior)", () => {
    const lastToolError: LastToolError = {
      toolName: "someTool",
      error: "Some error",
      mutatingAction: true,
    };
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: ["Some reply"],
      toolMetas: [],
      lastAssistant: {
        role: "assistant",
        content: [{ type: "text" as const, text: "Some reply" }],
        stopReason: "stop",
      } as any,
      lastToolError,
      sessionKey: "test",
      inlineToolResultsAllowed: false,
      isHeartbeat: false,
    });

    const toolErrorPayload = payloads.find((p) => p.isError && p.text?.includes("failed"));
    expect(toolErrorPayload).toBeDefined();
  });
});
