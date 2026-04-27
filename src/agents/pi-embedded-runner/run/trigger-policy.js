const DEFAULT_EMBEDDED_RUN_TRIGGER_POLICY = {
    injectHeartbeatPrompt: false,
};
const EMBEDDED_RUN_TRIGGER_POLICY = {
    heartbeat: {
        injectHeartbeatPrompt: true,
    },
};
export function shouldInjectHeartbeatPromptForTrigger(trigger) {
    return ((trigger ? EMBEDDED_RUN_TRIGGER_POLICY[trigger] : undefined)?.injectHeartbeatPrompt ??
        DEFAULT_EMBEDDED_RUN_TRIGGER_POLICY.injectHeartbeatPrompt);
}
