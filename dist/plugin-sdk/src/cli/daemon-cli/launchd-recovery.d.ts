declare const LAUNCH_AGENT_RECOVERY_MESSAGE = "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.";
type LaunchAgentRecoveryAction = "started" | "restarted";
type LaunchAgentRecoveryResult = {
    result: LaunchAgentRecoveryAction;
    loaded: true;
    message: string;
};
export declare function recoverInstalledLaunchAgent(params: {
    result: LaunchAgentRecoveryAction;
    env?: Record<string, string | undefined>;
}): Promise<LaunchAgentRecoveryResult | null>;
export { LAUNCH_AGENT_RECOVERY_MESSAGE };
