type LaunchdRestartHandoffMode = "kickstart" | "start-after-exit";
type LaunchdRestartHandoffResult = {
    ok: boolean;
    pid?: number;
    detail?: string;
};
export declare function isCurrentProcessLaunchdServiceLabel(label: string, env?: NodeJS.ProcessEnv): boolean;
export declare function scheduleDetachedLaunchdRestartHandoff(params: {
    env?: Record<string, string | undefined>;
    mode: LaunchdRestartHandoffMode;
    waitForPid?: number;
}): LaunchdRestartHandoffResult;
export {};
