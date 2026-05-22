import { execSchema } from "./bash-tools.exec-runtime.js";
import type { ExecToolDefaults, ExecToolDetails } from "./bash-tools.exec-types.js";
import { type AgentToolWithMeta } from "./tools/common.js";
export type { BashSandboxConfig } from "./bash-tools.shared.js";
export type { ExecElevatedDefaults, ExecToolDefaults, ExecToolDetails, } from "./bash-tools.exec-types.js";
declare function validateScriptFileForShellBleed(params: {
    command: string;
    workdir: string;
}): Promise<void>;
declare function parseOpenClawChannelsLoginShellCommand(raw: string): boolean;
export declare function createExecTool(defaults?: ExecToolDefaults): AgentToolWithMeta<typeof execSchema, ExecToolDetails>;
export declare const execTool: AgentToolWithMeta<import("typebox").TObject<{
    command: import("typebox").TString;
    workdir: import("typebox").TOptional<import("typebox").TString>;
    env: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
    yieldMs: import("typebox").TOptional<import("typebox").TNumber>;
    background: import("typebox").TOptional<import("typebox").TBoolean>;
    timeout: import("typebox").TOptional<import("typebox").TNumber>;
    pty: import("typebox").TOptional<import("typebox").TBoolean>;
    elevated: import("typebox").TOptional<import("typebox").TBoolean>;
    host: import("typebox").TOptional<import("typebox").TUnsafe<"auto" | "gateway" | "node" | "sandbox">>;
    security: import("typebox").TOptional<import("typebox").TString>;
    ask: import("typebox").TOptional<import("typebox").TString>;
    node: import("typebox").TOptional<import("typebox").TString>;
}>, ExecToolDetails>;
export declare const __testing: {
    parseOpenClawChannelsLoginShellCommand: typeof parseOpenClawChannelsLoginShellCommand;
    validateScriptFileForShellBleed: typeof validateScriptFileForShellBleed;
};
