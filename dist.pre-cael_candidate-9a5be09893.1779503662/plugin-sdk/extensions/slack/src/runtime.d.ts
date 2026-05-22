import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
type SlackChannelRuntime = {
    handleSlackAction?: typeof import("./action-runtime.js").handleSlackAction;
};
type SlackRuntime = PluginRuntime & {
    channel: PluginRuntime["channel"] & {
        slack?: SlackChannelRuntime;
    };
};
declare const setSlackRuntime: (next: SlackRuntime) => void, clearSlackRuntime: () => void, getOptionalSlackRuntime: () => SlackRuntime | null;
export { clearSlackRuntime, getOptionalSlackRuntime, setSlackRuntime };
