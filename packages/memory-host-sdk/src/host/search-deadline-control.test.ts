import { describe, expect, it, vi } from "vitest";
import { createMemorySearchDeadlineControl } from "./search-deadline-control.js";

describe("createMemorySearchDeadlineControl", () => {
  it("fans pause/resume edges out to subscribers", () => {
    const control = createMemorySearchDeadlineControl();
    const events: string[] = [];
    control.subscribe((action) => events.push(action));
    control.report("pause");
    control.report("resume");
    expect(events).toEqual(["pause", "resume"]);
  });

  it("balances overlapping owned phases so one resume cannot re-arm early", () => {
    const control = createMemorySearchDeadlineControl();
    const events: string[] = [];
    control.subscribe((action) => events.push(action));
    control.report("pause");
    control.report("pause");
    control.report("resume");
    expect(events).toEqual(["pause"]);
    control.report("resume");
    expect(events).toEqual(["pause", "resume"]);
  });

  it("ignores resume reports without a matching pause", () => {
    const control = createMemorySearchDeadlineControl();
    const listener = vi.fn();
    control.subscribe(listener);
    control.report("resume");
    expect(listener).not.toHaveBeenCalled();
  });

  it("replays the active pause to a subscriber that attaches mid-phase", () => {
    const control = createMemorySearchDeadlineControl();
    control.report("pause");
    const events: string[] = [];
    control.subscribe((action) => events.push(action));
    expect(events).toEqual(["pause"]);
    control.report("resume");
    expect(events).toEqual(["pause", "resume"]);
  });

  it("stops notifying after unsubscribe", () => {
    const control = createMemorySearchDeadlineControl();
    const listener = vi.fn();
    const unsubscribe = control.subscribe(listener);
    unsubscribe();
    control.report("pause");
    expect(listener).not.toHaveBeenCalled();
  });
});
