import type { OperationalRunInstanceRef } from "../../operational-run-instance.js";

/** In-process requester-turn receipts never grant completion authority. */
export type SubagentRequesterAccounting = {
  requesterRunInstance?: OperationalRunInstanceRef;
  requesterCompletion?: Readonly<{ runId: string; ended?: true }>;
};
