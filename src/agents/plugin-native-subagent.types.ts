import type { OpenClawConfig } from "../config/types.js";
import type { AdmittedRunContext, AdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import type { InternalCodingToolsOptions } from "./agent-tools.options.js";

// Leaf contract shared by the native subagent runtime and scheduled command turns.

export type NativeSubagentRequestSource = {
  options: InternalCodingToolsOptions & {
    agentId: string;
    sessionKey: string;
    sessionId: string;
    runId: string;
  };
  /** Required to refresh a supplied owner-prepared capability profile without dropping inputs. */
  prepareCurrentCapabilityProfile?: (
    config: OpenClawConfig,
  ) => Promise<NonNullable<InternalCodingToolsOptions["conversationCapabilityProfile"]>>;
  lifecycleRevision?: string;
  operatorAuthority: AdmittedRunOperatorAuthority;
  assertCurrent: () => void;
  prepareSpawn: (assertCurrent: () => void) => Promise<AdmittedRunContext>;
};
