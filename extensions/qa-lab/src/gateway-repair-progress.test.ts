import { describe, expect, it, vi } from "vitest";
import { createQaRepairProgressObserver } from "./gateway-repair-progress.js";

const event = (phase: string, status = "in_progress") =>
  `[update finalize] ${JSON.stringify({ step: `finalize:${phase}`, status })}\n`;

describe("repair phase progress", () => {
  it("recognizes split boundaries once, including combined chunks", () => {
    const progress = vi.fn();
    const observe = createQaRepairProgressObserver(progress);
    const first = Buffer.from(event("preflight"));
    observe(first.subarray(0, 12));
    expect(progress).not.toHaveBeenCalled();
    observe(first.subarray(12));
    observe(event("preflight", "completed") + event("doctor"));
    expect(progress).toHaveBeenCalledTimes(3);
  });

  it("does not renew for repeated, backward, failed, warning or arbitrary output", () => {
    const progress = vi.fn();
    const observe = createQaRepairProgressObserver(progress);
    observe(event("doctor"));
    for (const line of [
      event("doctor"),
      event("preflight", "completed"),
      event("doctor", "failed"),
      event("unknown"),
      '[update finalize] {"step":"warning:finalize:doctor:0","status":"completed"}\n',
      "[update finalize] null\n",
      "[update finalize] {\n",
      "ordinary output\n",
    ]) {
      observe(line);
    }
    expect(progress).toHaveBeenCalledTimes(1);
    observe(event("doctor", "completed"));
    expect(progress).toHaveBeenCalledTimes(2);
  });

  it("discards an oversized line including its apparent progress suffix, then recovers", () => {
    const progress = vi.fn();
    const observe = createQaRepairProgressObserver(progress);
    observe("x".repeat(8193));
    observe(event("completionCache"));
    expect(progress).not.toHaveBeenCalled();
    observe(event("preflight"));
    expect(progress).toHaveBeenCalledOnce();
  });
});
