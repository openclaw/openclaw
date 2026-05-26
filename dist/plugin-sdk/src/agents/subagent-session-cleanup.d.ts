import type { callGateway as defaultCallGateway } from "../gateway/call.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";
type CallGateway = typeof defaultCallGateway;
export declare function deleteSubagentSessionForCleanup(params: {
    callGateway: CallGateway;
    childSessionKey: string;
    spawnMode?: SpawnSubagentMode;
    onError?: (error: unknown) => void;
}): Promise<void>;
export {};
