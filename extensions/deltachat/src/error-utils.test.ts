import { describe, it, expect } from "vitest";
import { extractErrorMessage } from "./error-utils.js";

describe("extractErrorMessage", () => {
  it("should extract message from Error instances", () => {
    const error = new Error("Something went wrong");
    expect(extractErrorMessage(error)).toBe("Something went wrong");
  });

  it("should return string errors as-is", () => {
    expect(extractErrorMessage("Simple string error")).toBe("Simple string error");
  });

  it("should extract from object with message property (common in RPC errors)", () => {
    const error = { message: "RPC method failed" };
    expect(extractErrorMessage(error)).toBe("RPC method failed");
  });

  it("should extract from object with error property", () => {
    const error = { error: "Server error" };
    expect(extractErrorMessage(error)).toBe("Server error");
  });

  it("should extract from object with code property", () => {
    const error = { code: 404 };
    expect(extractErrorMessage(error)).toBe("Error code: 404");
  });

  it("should extract from object with string code property", () => {
    const error = { code: "ERR_CONNECTION_REFUSED" };
    expect(extractErrorMessage(error)).toBe("Error code: ERR_CONNECTION_REFUSED");
  });

  it("should extract from object with result property (JSON-RPC style)", () => {
    const error = { result: "Invalid account ID" };
    expect(extractErrorMessage(error)).toBe("Invalid account ID");
  });

  it("should stringify complex objects when no known error property exists", () => {
    const error = { status: "failed", details: { reason: "timeout" } };
    expect(extractErrorMessage(error)).toBe(JSON.stringify(error));
  });

  it("should handle null errors", () => {
    expect(extractErrorMessage(null)).toBe("null");
  });

  it("should handle undefined errors", () => {
    expect(extractErrorMessage(undefined)).toBe("undefined");
  });

  it("should handle number errors", () => {
    expect(extractErrorMessage(42)).toBe("42");
  });

  it("should handle Delta.Chat RPC style error objects", () => {
    // This is a common Delta.Chat RPC error structure
    const error = {
      message: "Failed to send message",
      code: "SEND_FAILED",
      details: { recipient: "test@example.com", reason: "network" },
    };
    expect(extractErrorMessage(error)).toBe("Failed to send message");
  });

  it("should handle errors that message takes precedence over other properties", () => {
    const error = {
      message: "Primary error message",
      error: "Secondary error",
      code: "ERR_OTHER",
    };
    expect(extractErrorMessage(error)).toBe("Primary error message");
  });
});
