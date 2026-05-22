import { type StuckSessionRecoveryOutcome, type StuckSessionRecoveryRequest } from "./diagnostic-session-recovery.js";
export type StuckSessionRecoveryParams = StuckSessionRecoveryRequest;
export declare function recoverStuckDiagnosticSession(params: StuckSessionRecoveryParams): Promise<StuckSessionRecoveryOutcome>;
export declare const testing: {
    resetRecoveriesInFlight(): void;
};
export { testing as __testing };
