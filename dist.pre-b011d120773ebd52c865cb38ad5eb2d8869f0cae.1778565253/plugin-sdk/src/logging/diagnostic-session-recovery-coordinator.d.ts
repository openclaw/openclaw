import type { SessionAttentionClassification } from "./diagnostic-session-attention.js";
import { type StuckSessionRecoveryOutcome, type StuckSessionRecoveryRequest } from "./diagnostic-session-recovery.js";
export type RecoverStuckSession = (params: StuckSessionRecoveryRequest) => void | StuckSessionRecoveryOutcome | Promise<void | StuckSessionRecoveryOutcome>;
export declare function requestStuckSessionRecovery(params: {
    recover: RecoverStuckSession;
    request: StuckSessionRecoveryRequest;
    classification: SessionAttentionClassification;
}): void;
export declare function resetDiagnosticSessionRecoveryCoordinatorForTest(): void;
