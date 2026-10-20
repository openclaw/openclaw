import { SdkError, SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { McpPaginationTimeoutError } from "./mcp-catalog-listing.js";
import { isMcpServiceAvailabilityError } from "./mcp-error.js";

describe("isMcpServiceAvailabilityError", () => {
  it("recognizes local deadlines without classifying their message text", () => {
    for (const error of [
      new SdkError(SdkErrorCode.RequestTimeout, "Request timed out"),
      new McpPaginationTimeoutError("MCP tool listing", 10_000),
      new Error("connection failed", {
        cause: Object.assign(new Error("deadline"), { code: "MCP_CONNECT_TIMEOUT" }),
      }),
    ]) {
      expect(isMcpServiceAvailabilityError(error, "streamable-http")).toBe(true);
      expect(isMcpServiceAvailabilityError(error, "stdio")).toBe(false);
    }
    expect(isMcpServiceAvailabilityError(new Error("Request timed out"), "streamable-http")).toBe(
      false,
    );
  });

  it.each([-32000, -32001])("does not reinterpret remote protocol code %s", (code) => {
    const error = Object.assign(new Error("Request timed out"), {
      code,
      cause: new SdkError(SdkErrorCode.RequestTimeout, "local-looking nested error"),
    });
    expect(isMcpServiceAvailabilityError(error, "streamable-http")).toBe(false);
  });

  it("keeps cause-less SDK connection closure as an error", () => {
    // Pending requests lose the initiating reason when a size/protocol guard,
    // replacement session, or ordinary cleanup closes the SDK transport.
    const error = new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed");
    expect(isMcpServiceAvailabilityError(error, "sse")).toBe(false);
    expect(isMcpServiceAvailabilityError(error, "streamable-http")).toBe(false);
  });

  it("accepts only known network failures through causes and aggregates", () => {
    const refused = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    const reset = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const network = new Error("fetch failed", { cause: new AggregateError([refused, reset]) });
    expect(isMcpServiceAvailabilityError(network, "sse")).toBe(true);
    expect(isMcpServiceAvailabilityError(network, "stdio")).toBe(false);
    expect(isMcpServiceAvailabilityError(new AggregateError([refused, missing]), "sse")).toBe(
      false,
    );
    expect(isMcpServiceAvailabilityError(new AggregateError([]), "sse")).toBe(false);
    const cyclic = new Error("cyclic", { cause: undefined });
    cyclic.cause = cyclic;
    expect(isMcpServiceAvailabilityError(cyclic, "sse")).toBe(false);
  });

  it.each([401, 403, 408, 429, 500, 503, 400, 404, 405])(
    "classifies typed HTTP status %s without accepting arbitrary status-shaped errors",
    (status) => {
      const error = new SdkHttpError(
        SdkErrorCode.ClientHttpFailedToTerminateSession,
        "HTTP failure",
        {
          status,
          statusText: "fixture",
        },
      );
      const unavailable = [401, 403, 408, 429, 500, 503].includes(status);
      expect(isMcpServiceAvailabilityError(error, "streamable-http")).toBe(unavailable);
      expect(isMcpServiceAvailabilityError(error, "stdio")).toBe(false);
      expect(isMcpServiceAvailabilityError({ status }, "streamable-http")).toBe(false);
    },
  );
});
