import { expect, it } from "vitest";
import { pollAutofillDecision } from "./autofill-poll.js";

it("uses the partner schedule with no early checks and no checks after two minutes", async () => {
  let now = 0;
  const checked: number[] = [];
  const result = await pollAutofillDecision({
    openedAt: 0,
    clock: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    check: async () => {
      checked.push(now);
      return { success: true, result: { path: "status", state: "pending", resolved: [] } };
    },
  });
  expect(result).toBeNull();
  expect(checked).toEqual([
    5000, 7000, 9000, 11000, 13000, 15000, 17000, 19000, 21000, 23000, 25000, 27000, 29000, 31000,
    36000, 41000, 46000, 51000, 56000, 61000, 71000, 81000, 91000, 101000, 111000, 120000,
  ]);
});
