import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OAUTH_REFRESH_CALL_TIMEOUT_MS } from "./constants.js";
import {
  beginOAuthRefreshObservation,
  captureOAuthRefreshSettlement,
} from "./oauth-refresh-observation.js";

afterEach(() => {
  vi.useRealTimers();
});

it("bounds one waiter without retiring durable refresh work for a later waiter", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const databasePath = path.resolve("synthetic-auth-observation.sqlite");
  const observation = beginOAuthRefreshObservation({
    databasePath,
    profileId: "custom:selected",
    provider: "custom",
    claimId: "synthetic-claim",
    generation: "synthetic-generation",
  });
  const capture = () =>
    captureOAuthRefreshSettlement({
      databasePaths: [databasePath],
      profileId: "custom:selected",
      matchesProvider: (provider) => provider === "custom",
    });
  const firstWait = capture();
  expect(firstWait).toEqual(expect.any(Function));
  const first = firstWait!();
  const timedOut = expect(first).rejects.toThrow("exceeded hard timeout");
  try {
    await vi.advanceTimersByTimeAsync(OAUTH_REFRESH_CALL_TIMEOUT_MS);
    await timedOut;
    const laterWait = capture();
    expect(laterWait).toEqual(expect.any(Function));
    let laterSettled = false;
    const later = laterWait!().then(() => {
      laterSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(laterSettled).toBe(false);
    observation.finish();
    await later;
    expect(laterSettled).toBe(true);
    expect(capture()).toBeUndefined();
  } finally {
    observation.finish();
    await Promise.allSettled([first, timedOut]);
  }
});
