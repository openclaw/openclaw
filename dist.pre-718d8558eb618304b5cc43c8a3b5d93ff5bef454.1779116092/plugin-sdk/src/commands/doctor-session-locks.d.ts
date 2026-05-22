import { type SessionLockOwnerProcessArgsReader, type SessionWriteLockAcquireTimeoutConfig } from "../agents/session-write-lock.js";
export declare function noteSessionLockHealth(params?: {
    shouldRepair?: boolean;
    config?: SessionWriteLockAcquireTimeoutConfig;
    env?: NodeJS.ProcessEnv;
    staleMs?: number;
    readOwnerProcessArgs?: SessionLockOwnerProcessArgsReader;
}): Promise<void>;
