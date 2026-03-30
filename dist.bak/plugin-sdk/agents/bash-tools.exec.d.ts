import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ExecToolDefaults, ExecToolDetails } from "./bash-tools.exec-types.js";
export type { BashSandboxConfig } from "./bash-tools.shared.js";
export type { ExecElevatedDefaults, ExecToolDefaults, ExecToolDetails, } from "./bash-tools.exec-types.js";
export declare function createExecTool(defaults?: ExecToolDefaults): AgentTool<any, ExecToolDetails>;
export declare const execTool: AgentTool<any, ExecToolDetails>;
