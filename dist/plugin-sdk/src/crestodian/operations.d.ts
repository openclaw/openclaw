import type { ConfigSetOptions } from "../cli/config-set-input.js";
import type { DoctorOptions } from "../commands/doctor.types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TuiResult } from "../tui/tui-types.js";
import type { CrestodianOverview } from "./overview.js";
type CrestodianOverviewLoader = () => Promise<CrestodianOverview>;
type CrestodianOverviewFormatter = (overview: CrestodianOverview) => string;
export type CrestodianOperation = {
    kind: "none";
    message: string;
} | {
    kind: "overview";
} | {
    kind: "doctor";
} | {
    kind: "doctor-fix";
} | {
    kind: "status";
} | {
    kind: "health";
} | {
    kind: "config-validate";
} | {
    kind: "config-set";
    path: string;
    value: string;
} | {
    kind: "config-set-ref";
    path: string;
    source: "env" | "file" | "exec";
    id: string;
    provider?: string;
} | {
    kind: "setup";
    workspace?: string;
    model?: string;
} | {
    kind: "gateway-status";
} | {
    kind: "gateway-start";
} | {
    kind: "gateway-stop";
} | {
    kind: "gateway-restart";
} | {
    kind: "agents";
} | {
    kind: "models";
} | {
    kind: "plugin-list";
} | {
    kind: "plugin-search";
    query: string;
} | {
    kind: "plugin-install";
    spec: string;
} | {
    kind: "plugin-uninstall";
    pluginId: string;
} | {
    kind: "audit";
} | {
    kind: "create-agent";
    agentId: string;
    workspace?: string;
    model?: string;
} | {
    kind: "open-tui";
    agentId?: string;
    workspace?: string;
} | {
    kind: "set-default-model";
    model: string;
};
export type CrestodianOperationResult = {
    applied: boolean;
    exitsInteractive?: boolean;
    message?: string;
    nextInput?: string;
};
export type CrestodianCommandDeps = {
    formatOverview?: CrestodianOverviewFormatter;
    loadOverview?: CrestodianOverviewLoader;
    runAgentsAdd?: (opts: {
        name?: string;
        workspace?: string;
        model?: string;
        nonInteractive?: boolean;
        json?: boolean;
    }, runtime: RuntimeEnv, params?: {
        hasFlags?: boolean;
    }) => Promise<void>;
    runConfigSet?: (opts: {
        path?: string;
        value?: string;
        cliOptions: ConfigSetOptions;
    }) => Promise<void>;
    runDoctor?: (runtime: RuntimeEnv, options: DoctorOptions) => Promise<void>;
    runGatewayRestart?: () => Promise<void>;
    runGatewayStart?: () => Promise<void>;
    runGatewayStop?: () => Promise<void>;
    runPluginInstall?: (spec: string, runtime: RuntimeEnv) => Promise<void>;
    runPluginUninstall?: (pluginId: string, runtime: RuntimeEnv) => Promise<void>;
    runPluginsList?: (runtime: RuntimeEnv) => Promise<void>;
    runPluginsSearch?: (query: string, runtime: RuntimeEnv) => Promise<void>;
    runTui?: (opts: {
        local: boolean;
        session?: string;
        deliver?: boolean;
        historyLimit?: number;
    }) => Promise<TuiResult | void>;
};
export declare function parseCrestodianOperation(input: string): CrestodianOperation;
export declare function isPersistentCrestodianOperation(operation: CrestodianOperation): boolean;
export declare function describeCrestodianPersistentOperation(operation: CrestodianOperation): string;
export declare function formatCrestodianPersistentPlan(operation: CrestodianOperation): string;
export declare function executeCrestodianOperation(operation: CrestodianOperation, runtime: RuntimeEnv, opts?: {
    approved?: boolean;
    deps?: CrestodianCommandDeps;
    auditDetails?: Record<string, unknown>;
}): Promise<CrestodianOperationResult>;
export {};
