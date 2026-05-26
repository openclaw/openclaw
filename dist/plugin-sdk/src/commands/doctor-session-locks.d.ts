import { type SessionLockOwnerProcessArgsReader } from "../agents/session-write-lock.js";
export declare function noteSessionLockHealth(params?: {
    shouldRepair?: boolean;
    staleMs?: number;
    readOwnerProcessArgs?: SessionLockOwnerProcessArgsReader;
}): Promise<void>;
