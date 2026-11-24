import { afterEach, describe, expect, it } from "vitest";
import {
  clearBoundaryMaintenance,
  declineBoundaryMaintenance,
  decideContextPressure,
  exceedsContextWindow,
  isToolBatchBoundarySafe,
} from "./context-pressure.js";

const WINDOW = 272_000;
const RUN = "run-context-pressure-test";

afterEach(() => clearBoundaryMaintenance(RUN));

describe("decideContextPressure", () => {
  // Every combination of the decision inputs; the rule is checked, not a fixture table.
  const estimates = [0, 204_000, 206_000, WINDOW, WINDOW + 1, 1_084_694];
  const flags = [false, true];
  for (const estimatedPromptTokens of estimates) {
    for (const maintenanceDue of flags) {
      for (const boundarySafe of flags) {
        for (const declined of flags) {
          it(`est=${estimatedPromptTokens} due=${maintenanceDue} safe=${boundarySafe} declined=${declined}`, () => {
            if (declined) {
              declineBoundaryMaintenance(RUN);
            }
            const decision = decideContextPressure({
              estimatedPromptTokens,
              windowTokens: WINDOW,
              maintenanceDue,
              boundarySafe,
              runId: RUN,
            });
            const overWindow = estimatedPromptTokens > WINDOW;
            // Only a request that cannot fit may fail a turn.
            expect(decision === "overflow").toBe(overWindow);
            // Soft pressure only schedules maintenance, and only at a safe boundary.
            expect(decision === "maintenance").toBe(
              !overWindow && maintenanceDue && boundarySafe && !declined,
            );
          });
        }
      }
    }
  }

  it("reproduces the #200483 stop: 206k on a 272k window with a 204k threshold", () => {
    expect(
      decideContextPressure({
        estimatedPromptTokens: 206_000,
        windowTokens: WINDOW,
        maintenanceDue: true,
        boundarySafe: false,
      }),
    ).toBeUndefined();
  });
});

describe("exceedsContextWindow", () => {
  it("treats unknown or invalid sizes as fitting", () => {
    expect(exceedsContextWindow(undefined, WINDOW)).toBe(false);
    expect(exceedsContextWindow(WINDOW + 1, undefined)).toBe(false);
    expect(exceedsContextWindow(Number.NaN, WINDOW)).toBe(false);
    expect(exceedsContextWindow(WINDOW + 1, 0)).toBe(false);
    expect(exceedsContextWindow(WINDOW, WINDOW)).toBe(false);
    expect(exceedsContextWindow(WINDOW + 1, WINDOW)).toBe(true);
  });
});

describe("isToolBatchBoundarySafe", () => {
  const settled = {
    pendingToolCalls: 0,
    itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
    asyncActivity: false,
    parkedCodeModeRun: false,
    approvalPromptSent: false,
  };
  it("accepts only a fully settled batch", () => {
    expect(isToolBatchBoundarySafe(settled)).toBe(true);
    expect(isToolBatchBoundarySafe({ ...settled, pendingToolCalls: 1 })).toBe(false);
    expect(
      isToolBatchBoundarySafe({
        ...settled,
        itemLifecycle: { startedCount: 2, completedCount: 1, activeCount: 1 },
      }),
    ).toBe(false);
    // A background exec reports into this attempt.
    expect(isToolBatchBoundarySafe({ ...settled, asyncActivity: true })).toBe(false);
    expect(isToolBatchBoundarySafe({ ...settled, approvalPromptSent: true })).toBe(false);
    // A parked Code Mode `wait` is bound to this session; compaction may rotate it.
    expect(isToolBatchBoundarySafe({ ...settled, parkedCodeModeRun: true })).toBe(false);
  });
});
