import { describe, expect, it } from "vitest";
import { createCursorSdkAgentHarness } from "./harness.js";

describe("createCursorSdkAgentHarness", () => {
  const harness = createCursorSdkAgentHarness();

  it("has id cursor-sdk", () => {
    expect(harness.id).toBe("cursor-sdk");
  });

  it("supports cursor-sdk provider", () => {
    const result = harness.supports({
      provider: "cursor-sdk",
      requestedRuntime: "auto",
    });
    expect(result).toEqual({ supported: true, priority: 100 });
  });

  it("supports case-insensitive provider", () => {
    const result = harness.supports({
      provider: "Cursor-SDK",
      requestedRuntime: "auto",
    });
    expect(result).toEqual({ supported: true, priority: 100 });
  });

  it("rejects other providers", () => {
    const result = harness.supports({
      provider: "openai",
      requestedRuntime: "auto",
    });
    expect(result.supported).toBe(false);
  });
});
