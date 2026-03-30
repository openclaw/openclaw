import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackMonitorContext } from "./context.js";
export declare function registerSlackMonitorSlashCommands(params: {
    ctx: SlackMonitorContext;
    account: ResolvedSlackAccount;
}): Promise<void>;
