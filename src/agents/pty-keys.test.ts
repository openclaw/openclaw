/**
 * Regression coverage for PTY key encoding.
 * Protects terminal control bytes used by process send-keys and PTY sessions.
 */
import { expect, test } from "vitest";
import { encodeKeySequence, encodePaste } from "./pty-keys.js";

const ESC = "\x1b";

test("encodeKeySequence maps common keys and modifiers", () => {
  const enter = encodeKeySequence({ keys: ["Enter"] });
  expect(enter.data).toEqual(Buffer.from("\r"));

  const ctrlC = encodeKeySequence({ keys: ["C-c"] });
  expect(ctrlC.data).toEqual(Buffer.from("\x03"));

  const altX = encodeKeySequence({ keys: ["M-x"] });
  expect(altX.data).toEqual(Buffer.from("\x1bx"));

  const shiftTab = encodeKeySequence({ keys: ["S-Tab"] });
  expect(shiftTab.data).toEqual(Buffer.from("\x1b[Z"));

  const kpEnter = encodeKeySequence({ keys: ["KPEnter"] });
  expect(kpEnter.data).toEqual(Buffer.from("\x1bOM"));
});

test("encodeKeySequence uses SS3 sequences in application cursor key mode", () => {
  // Application mode (smkx) uses SS3 sequences.
  const up = encodeKeySequence({ keys: ["up"] }, "application");
  expect(up.data).toEqual(Buffer.from(`${ESC}OA`));

  const down = encodeKeySequence({ keys: ["down"] }, "application");
  expect(down.data).toEqual(Buffer.from(`${ESC}OB`));

  const right = encodeKeySequence({ keys: ["right"] }, "application");
  expect(right.data).toEqual(Buffer.from(`${ESC}OC`));

  const left = encodeKeySequence({ keys: ["left"] }, "application");
  expect(left.data).toEqual(Buffer.from(`${ESC}OD`));

  // Home/End also use SS3 sequences in application mode.
  const home = encodeKeySequence({ keys: ["home"] }, "application");
  expect(home.data).toEqual(Buffer.from(`${ESC}OH`));

  const end = encodeKeySequence({ keys: ["end"] }, "application");
  expect(end.data).toEqual(Buffer.from(`${ESC}OF`));
});

test.each([
  ["M-up", `${ESC}[1;3A`],
  ["S-M-C-PgDn", `${ESC}[6;8~`],
  ["S-F4", `${ESC}[1;2S`],
])("encodeKeySequence applies xterm modifiers to %s in every cursor mode", (key, data) => {
  for (const mode of [undefined, "normal", "application"] as const) {
    expect(encodeKeySequence({ keys: [key] }, mode)).toEqual({
      data: Buffer.from(data),
      warnings: [],
    });
  }
});

test.each([["C-M-Space", `${ESC}\x00`]])("encodeKeySequence encodes %s", (key, data) => {
  expect(encodeKeySequence({ keys: [key] })).toEqual({ data: Buffer.from(data), warnings: [] });
});

test("encodeKeySequence supports hex + literal with warnings", () => {
  const result = encodeKeySequence({
    literal: "hi",
    hex: ["0d", "0x0a", "zz"],
    keys: ["Enter"],
  });
  expect(result.data).toEqual(Buffer.from("hi\r\n\r"));
  expect(result.warnings).toStrictEqual(["Invalid hex byte: zz"]);
});

test("encodePaste wraps bracketed sequences by default", () => {
  const payload = encodePaste("line1\nline2\n");
  expect(payload.startsWith(`${ESC}[200~`)).toBe(true);
  expect(payload.endsWith(`${ESC}[201~`)).toBe(true);
});
