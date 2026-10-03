import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { expect, it } from "vitest";
import { isMcpServiceAvailabilityError } from "./mcp-error.js";

it("recognizes transport closure and unavailable DNS without downgrading local failures", () => {
  expect(isMcpServiceAvailabilityError(new McpError(ErrorCode.ConnectionClosed, "closed"))).toBe(
    true,
  );
  expect(isMcpServiceAvailabilityError(new StreamableHTTPError(401, "unauthorized"))).toBe(true);
  expect(isMcpServiceAvailabilityError(new StreamableHTTPError(503, "unavailable"))).toBe(true);
  expect(
    isMcpServiceAvailabilityError(
      Object.assign(new Error("DNS unavailable"), { code: "ENOTFOUND" }),
    ),
  ).toBe(true);
  expect(
    isMcpServiceAvailabilityError(Object.assign(new Error("missing command"), { code: "ENOENT" })),
  ).toBe(false);
  expect(isMcpServiceAvailabilityError(new Error("invalid tool schema"))).toBe(false);
  expect(
    isMcpServiceAvailabilityError(
      new AggregateError([
        Object.assign(new Error("DNS unavailable"), { code: "ENOTFOUND" }),
        Object.assign(new Error("missing command"), { code: "ENOENT" }),
      ]),
    ),
  ).toBe(false);
  expect(
    isMcpServiceAvailabilityError(
      new AggregateError([
        Object.assign(new Error("DNS unavailable"), { code: "ENOTFOUND" }),
        Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
      ]),
    ),
  ).toBe(true);
});
