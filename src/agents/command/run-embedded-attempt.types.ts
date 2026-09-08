import type { SessionEntry } from "../../config/sessions/types.js";
import type { prepareAgentCommandExecutionIdentity } from "../agent-command-execution-identity.js";
import type { CompactionAccountingFact } from "../embedded-agent-runner/run/internal-params.js";
import type { AgentRunSessionTarget } from "../run-session-target.js";
import type { EmbeddedModelSelection } from "./model-selection.js";
import type { PreparedAgentCommandExecution } from "./prepare.js";
import type { EmbeddedSessionState } from "./session-preparation.js";
import type { AgentCommandOpts } from "./types.js";

export type RunEmbeddedAgentAttemptParams = {
  preparedRunAdmission: ReturnType<typeof prepareAgentCommandExecutionIdentity>;
  prepared: PreparedAgentCommandExecution;
  opts: AgentCommandOpts;
  sessionEntry?: SessionEntry;
  lifecycleGeneration: string;
  onLifecycleGenerationChanged: (lifecycleGeneration: string) => void;
  onCompactionAccounting?: (fact: CompactionAccountingFact) => void;
  suppressVisibleSessionEffects: boolean;
  preserveUserFacingSessionModelState: boolean;
  modelSelection: EmbeddedModelSelection;
  embeddedSessionState: EmbeddedSessionState;
  trackInternalModelRunTarget: (target: AgentRunSessionTarget | undefined) => void;
};
