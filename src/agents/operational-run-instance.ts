import { randomUUID } from "node:crypto";

/** Operational lifecycle correlation. This is never identity or authorization evidence. */
export type OperationalRunInstanceRef = Readonly<{
  instanceId: string;
  runId: string;
}>;

export function createOperationalRunInstanceRef(runId: string): OperationalRunInstanceRef {
  return Object.freeze({ instanceId: randomUUID(), runId });
}
