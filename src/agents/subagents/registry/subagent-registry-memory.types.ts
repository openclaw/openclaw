import type { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import type { OperationalRunInstanceRef } from "../../operational-run-instance.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** In-process custody only; requester accounting never grants completion authority. */
export type SubagentCompletionCustody = {
  authority: NonNullable<Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>>;
  entry: SubagentRunRecord;
  requesterRunInstance?: OperationalRunInstanceRef;
  stop: () => void;
};
