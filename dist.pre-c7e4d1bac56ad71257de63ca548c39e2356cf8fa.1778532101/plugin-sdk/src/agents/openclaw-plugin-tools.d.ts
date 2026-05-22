import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { type OpenClawPluginToolOptions } from "./openclaw-tools.plugin-context.js";
import type { AnyAgentTool } from "./tools/common.js";
type ResolveOpenClawPluginToolsOptions = OpenClawPluginToolOptions & {
    pluginToolAllowlist?: string[];
    pluginToolDenylist?: string[];
    currentChannelId?: string;
    currentThreadTs?: string;
    currentMessageId?: string | number;
    sandboxRoot?: string;
    modelHasVision?: boolean;
    modelProvider?: string;
    allowMediaInvokeCommands?: boolean;
    requesterAgentIdOverride?: string;
    requireExplicitMessageTarget?: boolean;
    disableMessageTool?: boolean;
    disablePluginTools?: boolean;
    authProfileStore?: AuthProfileStore;
};
export declare function resolveOpenClawPluginToolsForOptions(params: {
    options?: ResolveOpenClawPluginToolsOptions;
    resolvedConfig?: OpenClawConfig;
    existingToolNames?: Set<string>;
}): AnyAgentTool[];
export {};
