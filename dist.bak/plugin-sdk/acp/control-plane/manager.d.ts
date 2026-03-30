import { AcpSessionManager } from "./manager.core.js";
export { AcpSessionManager } from "./manager.core.js";
export type { AcpCloseSessionInput, AcpCloseSessionResult, AcpInitializeSessionInput, AcpManagerObservabilitySnapshot, AcpRunTurnInput, AcpSessionResolution, AcpSessionRuntimeOptions, AcpSessionStatus, AcpStartupIdentityReconcileResult, } from "./manager.types.js";
export declare function getAcpSessionManager(): AcpSessionManager;
export declare const __testing: {
    resetAcpSessionManagerForTests(): void;
};
