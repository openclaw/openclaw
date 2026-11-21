import { expect, it } from "vitest";
import { until } from "./subagent-challenges.live.test-support.js";

it("stops polling when its owning live test is cancelled", async () => {
  const controller = new AbortController();
  const reason = new Error("owning live test cancelled");
  let reads = 0;
  const result = until(
    "cancelled child execution",
    () => {
      reads++;
      if (reads === 1) {
        controller.abort(reason);
        return undefined;
      }
      return "late result";
    },
    1_000,
    controller.signal,
  );
  await expect(result).rejects.toBe(reason);
  expect(reads).toBe(1);
});
