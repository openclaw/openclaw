import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
export type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";
export declare function executeNodeHostCommand(params: ExecuteNodeHostCommandParams): Promise<AgentToolResult<ExecToolDetails>>;
