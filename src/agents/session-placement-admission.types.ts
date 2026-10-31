import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { GitHubCredentialReader } from "./github-credential-reader.js";

export type LocalTurnPlacementClaim = {
  sessionId: string;
  agentId?: string;
  sessionKey?: string;
  runId: string;
};

/** Shared admission operation; request contracts must not import the agent runtime. */
export type RequiredSessionPlacementAdmission = <T>(
  identity: Omit<LocalTurnPlacementClaim, "runId">,
  task: (assertPlacementCurrent: SessionSourceAssertion) => Promise<T>,
  assertCurrent?: SessionSourceAssertion,
  signal?: AbortSignal,
  preparation?: {
    waitForReady: false;
    retainDispatch?: () => () => void;
    readNativeCredential?: GitHubCredentialReader;
  },
) => Promise<T>;
