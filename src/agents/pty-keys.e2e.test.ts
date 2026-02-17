import { expect, test } from "vitest";
import { buildCursorPositionResponse, stripDsrRequests } from "./pty-dsr.js";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  encodeKeySequence,
  encodePaste,
} from "./pty-keys.js";

test("encodeKeySequence maps common keys and modifiers", () => {
  const enter = encodeKeySequence({ keys: ["Enter"] });
  expect(enter.data).toBe("\r");

  const ctrlC = encodeKeySequence({ keys: ["C-c"] });
  expect(ctrlC.data).toBe("\x03");

  const altX = encodeKeySequence({ keys: ["M-x"] });
  expect(altX.data).toBe("\x1bx");

  const shiftTab = encodeKeySequence({ keys: ["S-Tab"] });
  expect(shiftTab.data).toBe("\x1b[Z");

  const kpEnter = encodeKeySequence({ keys: ["KPEnter"] });
  expect(kpEnter.data).toBe("\x1bOM");
});

test("encodeKeySequence supports hex + literal with warnings", () => {
  const result = encodeKeySequence({
    literal: "hi",
    hex: ["0d", "0x0a", "zz"],
    keys: ["Enter"],
  });
  expect(result.data).toBe("hi\r\n\r");
  expect(result.warnings.length).toBe(1);
});

test("encodePaste wraps bracketed sequences by default", () => {
  const payload = encodePaste("line1\nline2\n");
  expect(payload.startsWith(BRACKETED_PASTE_START)).toBe(true);
  expect(payload.endsWith(BRACKETED_PASTE_END)).toBe(true);
});

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
