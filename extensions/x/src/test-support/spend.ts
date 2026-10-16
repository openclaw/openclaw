import { randomUUID } from "node:crypto";
import { resolveXCostLimits, type XCostLimits } from "../cost-limits.js";
import { openXSpend } from "../spend.js";
import { createKeyedState } from "./monitor.js";

export function createXTestSpend(limits: Partial<XCostLimits> = {}) {
  const stateDir = `synthetic-x-spend:${randomUUID()}`;
  return openXSpend(
    { state: { openKeyedStore: createKeyedState(), resolveStateDir: () => stateDir } },
    "default",
    () => resolveXCostLimits(limits),
  );
}
