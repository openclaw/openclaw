import { expectTypeOf, it } from "vitest";
import type { AgentHarnessAttemptResult } from "./types.js";

it("retains optional legacy timeout flags on harness results", () => {
  type LegacyResult = Exclude<AgentHarnessAttemptResult, { terminal: unknown }>;
  expectTypeOf<
    Pick<LegacyResult, "timedOutDuringToolExecution" | "timedOutByRunBudget">
  >().toEqualTypeOf<{
    timedOutDuringToolExecution?: boolean;
    timedOutByRunBudget?: boolean;
  }>();
});
