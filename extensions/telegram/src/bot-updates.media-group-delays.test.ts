// Album flush scheduling: Telegram delivers members about a second apart, so the
// first member waits the arrival window while later members keep the quiet window.
import { expect, it } from "vitest";
import { resolveMediaGroupFlushDelays } from "./bot-updates.js";

it("waits the arrival window for the first member and the quiet window afterwards", () => {
  expect(resolveMediaGroupFlushDelays()).toEqual({ flushMs: 500, arrivalMs: 1_500 });
  expect(resolveMediaGroupFlushDelays({})).toEqual({ flushMs: 500, arrivalMs: 1_500 });
});

it("lets tests override both windows and keeps them ordered", () => {
  expect(resolveMediaGroupFlushDelays({ mediaGroupFlushMs: 20 })).toEqual({
    flushMs: 20,
    arrivalMs: 20,
  });
  expect(resolveMediaGroupFlushDelays({ mediaGroupFlushMs: 20, mediaGroupArrivalMs: 600 })).toEqual(
    { flushMs: 20, arrivalMs: 600 },
  );
  expect(resolveMediaGroupFlushDelays({ mediaGroupArrivalMs: 1 })).toEqual({
    flushMs: 500,
    arrivalMs: 10,
  });
});
