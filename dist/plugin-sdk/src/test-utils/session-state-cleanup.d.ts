import { drainSessionWriteLockStateForTest } from "../agents/session-write-lock.js";
import { drainSessionStoreWriterQueuesForTest } from "../config/sessions/store-writer-state.js";
import { drainFileLockStateForTest } from "../infra/file-lock.js";
export declare function setSessionStateCleanupRuntimeForTests(params: {
    drainFileLockStateForTest?: typeof drainFileLockStateForTest | null;
    drainSessionStoreWriterQueuesForTest?: typeof drainSessionStoreWriterQueuesForTest | null;
    drainSessionWriteLockStateForTest?: typeof drainSessionWriteLockStateForTest | null;
}): void;
export declare function resetSessionStateCleanupRuntimeForTests(): void;
export declare function cleanupSessionStateForTest(): Promise<void>;
