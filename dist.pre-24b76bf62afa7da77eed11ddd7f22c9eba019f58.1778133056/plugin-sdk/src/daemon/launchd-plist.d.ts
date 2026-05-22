import type { GatewayServiceEnvironmentValueSource } from "./service-types.js";
export declare const LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS = 1;
export declare const LAUNCH_AGENT_UMASK_DECIMAL = 63;
export declare function readLaunchAgentProgramArgumentsFromFile(plistPath: string): Promise<{
    programArguments: string[];
    workingDirectory?: string;
    environment?: Record<string, string>;
    environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource>;
    sourcePath?: string;
} | null>;
export declare function buildLaunchAgentPlist({ label, comment, programArguments, workingDirectory, stdoutPath, stderrPath, environment }: {
    label: string;
    comment?: string;
    programArguments: string[];
    workingDirectory?: string;
    stdoutPath: string;
    stderrPath: string;
    environment?: Record<string, string | undefined>;
}): string;
