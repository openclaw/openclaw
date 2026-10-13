import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

/** Keeps trajectory callbacks bound to the exact foreground host lifetime. */
export function bindHarnessTrajectory(
  recorder: NonNullable<AgentHarnessHostCapabilities["trajectory"]>,
  assertActive: () => void,
): NonNullable<AgentHarnessHostCapabilities["trajectory"]> {
  return Object.freeze({
    recordEvent: (type: string, data?: Record<string, unknown>) => {
      assertActive();
      recorder.recordEvent(type, data);
    },
    flush: async () => {
      assertActive();
      await recorder.flush();
      assertActive();
    },
  });
}
