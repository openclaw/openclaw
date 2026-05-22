import type { CommandContext } from "../auto-reply/reply/commands-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type CrestodianCommandDeps } from "./operations.js";
export type CrestodianRescueMessageInput = {
    cfg: OpenClawConfig;
    command: CommandContext;
    commandBody: string;
    agentId?: string;
    isGroup: boolean;
    env?: NodeJS.ProcessEnv;
    deps?: CrestodianCommandDeps;
};
export declare function extractCrestodianRescueMessage(commandBody: string): string | null;
export declare function runCrestodianRescueMessage(input: CrestodianRescueMessageInput): Promise<string | null>;
