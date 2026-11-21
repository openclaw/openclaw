import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { resolveXCostLimits, type XCostLimits } from "../cost-limits.js";
import { openXSpend } from "../spend.js";
import { createKeyedState } from "./monitor.js";

export function createXTestSpend(limits: Partial<XCostLimits> = {}) {
  const stateDir = `synthetic-x-spend:${randomUUID()}`;
  return openXSpend(
    {
      state: { openKeyedStore: createKeyedState(), resolveStateDir: () => stateDir },
      logging: {
        getChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
      },
    },
    "default",
    () => resolveXCostLimits(limits),
  );
}
