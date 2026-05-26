import type { GatewayServiceEnvironmentValueSource } from "./service-types.js";
export declare const LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS = 10;
export declare const LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS = 20;
export declare const LAUNCH_AGENT_UMASK_DECIMAL = 63;
export declare const LAUNCH_AGENT_PROCESS_TYPE = "Interactive";
export declare const LAUNCH_AGENT_STDIN_PATH = "/dev/null";
type ReadLaunchAgentProgramArgumentsOptions = {
    expectedEnvironmentWrapperPath?: string;
    expectedEnvironmentFilePath?: string;
    generatedEnvironmentLabel?: string;
};
export declare function readLaunchAgentProgramArgumentsFromFile(plistPath: string): Promise<{
    programArguments: string[];
    workingDirectory?: string;
    environment?: Record<string, string>;
    environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource>;
    sourcePath?: string;
} | null>;
export declare function readLaunchAgentProgramArgumentsFromFile(plistPath: string, options: ReadLaunchAgentProgramArgumentsOptions): Promise<{
    programArguments: string[];
    workingDirectory?: string;
    environment?: Record<string, string>;
    environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource>;
    sourcePath?: string;
} | null>;
export declare function buildLaunchAgentPlist({ label, comment, programArguments, workingDirectory, stdoutPath, stderrPath, environment, }: {
    label: string;
    comment?: string;
    programArguments: string[];
    workingDirectory?: string;
    stdoutPath: string;
    stderrPath: string;
    environment?: Record<string, string | undefined>;
}): string;
export {};
