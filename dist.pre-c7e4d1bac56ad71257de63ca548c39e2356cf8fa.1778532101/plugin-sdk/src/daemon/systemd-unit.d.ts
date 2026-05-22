import type { GatewayServiceRenderArgs } from "./service-types.js";
export declare function buildSystemdUnit({ description, programArguments, workingDirectory, environment, environmentFiles }: GatewayServiceRenderArgs): string;
export declare function parseSystemdExecStart(value: string): string[];
export declare function parseSystemdEnvAssignment(raw: string): {
    key: string;
    value: string;
} | null;
