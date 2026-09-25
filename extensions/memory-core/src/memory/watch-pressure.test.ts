import { expect, it, vi } from "vitest";
import { warnIfMemoryWatchPressureHigh } from "./watch-pressure.js";

it("reports named directory facts once, without claiming a kernel-watch census", () => {
  const state = { shown: false };
  const warn = vi.fn();
  expect(
    warnIfMemoryWatchPressureHigh(
      state,
      2000,
      "registered directories",
      "pressure",
      "remediation",
      warn,
    ),
  ).toBe(false);
  expect(
    warnIfMemoryWatchPressureHigh(
      state,
      2001,
      "registered directories",
      "pressure",
      "remediation",
      warn,
    ),
  ).toBe(true);
  expect(
    warnIfMemoryWatchPressureHigh(
      state,
      4000,
      "registered directories",
      "pressure",
      "remediation",
      warn,
    ),
  ).toBe(false);
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    "Memory file watching is tracking 2001 registered directories. pressure remediation",
  );
});
