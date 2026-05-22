import { resolveDaemonContainerContext } from "../../daemon/container-context.js";
import { formatRuntimeStatus } from "../../daemon/runtime-format.js";
import { parsePort } from "../shared/parse-port.js";
export { formatRuntimeStatus };
export { parsePort };
export { resolveDaemonContainerContext };
export declare function createDaemonInstallActionContext(jsonFlag: unknown): {
    stdout: import("node:stream").Writable;
    warnings: string[];
    emit: (payload: Omit<import("./response.js").DaemonActionResponse, "action">) => void;
    fail: (message: string, hints?: string[]) => void;
    json: boolean;
};
export declare function failIfNixDaemonInstallMode(fail: (message: string, hints?: string[]) => void, env?: NodeJS.ProcessEnv): boolean;
export declare function createCliStatusTextStyles(): {
    rich: boolean;
    label: (value: string) => string;
    accent: (value: string) => string;
    infoText: (value: string) => string;
    okText: (value: string) => string;
    warnText: (value: string) => string;
    errorText: (value: string) => string;
};
export declare function resolveRuntimeStatusColor(status: string | undefined): (value: string) => string;
export declare function parsePortFromArgs(programArguments: string[] | undefined): number | null;
export declare function pickProbeHostForBind(bindMode: string, tailnetIPv4: string | undefined, customBindHost?: string): string;
export declare function filterDaemonEnv(env: Record<string, string> | undefined): Record<string, string>;
export declare function safeDaemonEnv(env: Record<string, string> | undefined): string[];
export declare function normalizeListenerAddress(raw: string): string;
export declare function renderRuntimeHints(runtime: {
    missingUnit?: boolean;
    missingSupervision?: boolean;
    status?: string;
} | undefined, env?: NodeJS.ProcessEnv, logFile?: string | null): string[];
export declare function renderGatewayServiceStartHints(env?: NodeJS.ProcessEnv): string[];
export declare function filterContainerGenericHints(hints: string[], env?: NodeJS.ProcessEnv): string[];
