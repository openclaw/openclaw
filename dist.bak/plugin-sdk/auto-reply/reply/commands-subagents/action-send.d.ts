import type { CommandHandlerResult } from "../commands-types.js";
import { type SubagentsCommandContext } from "./shared.js";
export declare function handleSubagentsSendAction(ctx: SubagentsCommandContext, steerRequested: boolean): Promise<CommandHandlerResult>;
