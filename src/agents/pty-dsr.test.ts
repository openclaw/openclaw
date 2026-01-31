import { expect, test } from "vitest";

import { buildCursorPositionResponse, stripDsrRequests } from "./pty-dsr.js";

test("stripDsrRequests removes cursor queries and counts them", () => {
  const input = "hi\x1b[6nthere\x1b[?6n";
  const { cleaned, requests } = stripDsrRequests(input);
  expect(cleaned).toBe("hithere");
  expect(requests).toBe(2);
});

test("buildCursorPositionResponse returns CPR sequence", () => {
  expect(buildCursorPositionResponse()).toBe("\x1b[1;1R");
  expect(buildCursorPositionResponse(12, 34)).toBe("\x1b[12;34R");
});
