import type { OpenClawConfig } from "../config/config.js";
import type { ExecToolConfig } from "../config/types.tools.js";
export type ExecFilesystemPolicyDriftHit = {
    scopeLabel: string;
    runtimeTools: string[];
    disabledFilesystemTools: string[];
    sandboxMode: "off" | "non-main" | "all";
    sandboxWorkspaceAccess: "none" | "ro" | "rw";
    execHost: NonNullable<ExecToolConfig["host"]>;
};
export declare function collectExecFilesystemPolicyDriftHits(cfg: OpenClawConfig): ExecFilesystemPolicyDriftHit[];
