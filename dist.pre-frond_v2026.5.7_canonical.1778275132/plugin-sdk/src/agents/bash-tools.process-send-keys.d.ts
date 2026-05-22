import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ProcessSession } from "./bash-process-registry.js";
export type WritableStdin = {
    write: (data: string, cb?: (err?: Error | null) => void) => void;
    end: () => void;
    destroyed?: boolean;
};
export declare function handleProcessSendKeys(params: {
    sessionId: string;
    session: ProcessSession;
    stdin: WritableStdin;
    keys?: string[];
    hex?: string[];
    literal?: string;
}): Promise<AgentToolResult<unknown>>;
