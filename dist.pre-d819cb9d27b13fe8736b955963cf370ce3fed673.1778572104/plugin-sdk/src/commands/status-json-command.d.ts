import { type RuntimeEnv } from "../runtime.js";
import { resolveStatusJsonOutput } from "./status-json-runtime.ts";
type StatusJsonCommandOptions = {
    deep?: boolean;
    usage?: boolean;
    timeoutMs?: number;
    all?: boolean;
};
export declare function runStatusJsonCommand(params: {
    opts: StatusJsonCommandOptions;
    runtime: RuntimeEnv;
    includeSecurityAudit: boolean;
    includePluginCompatibility?: boolean;
    suppressHealthErrors?: boolean;
    scanStatusJsonFast: (opts: {
        timeoutMs?: number;
        all?: boolean;
    }, runtime: RuntimeEnv) => Promise<Parameters<typeof resolveStatusJsonOutput>[0]["scan"]>;
}): Promise<void>;
export {};
