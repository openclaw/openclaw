import type { GatewayServiceRenderArgs } from "./service-types.js";
export declare function buildSystemdUnit({ description, programArguments, workingDirectory, environment, environmentFiles, }: GatewayServiceRenderArgs): string;
export declare function parseSystemdExecStart(value: string): string[];
export declare function parseSystemdEnvAssignment(raw: string): {
    key: string;
    value: string;
} | null;
export declare function parseSystemdEnvAssignments(raw: string): Array<{
    key: string;
    value: string;
}>;
export declare function renderSystemdEnvAssignment(key: string, value: string): string;
