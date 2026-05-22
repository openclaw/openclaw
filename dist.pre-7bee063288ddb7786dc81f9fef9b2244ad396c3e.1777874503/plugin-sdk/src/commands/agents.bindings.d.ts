import type { AgentRouteBinding } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ChannelChoice } from "./onboard-types.js";
export { describeBinding } from "./agents.binding-format.js";
export declare function applyAgentBindings(cfg: OpenClawConfig, bindings: AgentRouteBinding[]): {
    config: OpenClawConfig;
    added: AgentRouteBinding[];
    updated: AgentRouteBinding[];
    skipped: AgentRouteBinding[];
    conflicts: Array<{
        binding: AgentRouteBinding;
        existingAgentId: string;
    }>;
};
export declare function removeAgentBindings(cfg: OpenClawConfig, bindings: AgentRouteBinding[]): {
    config: OpenClawConfig;
    removed: AgentRouteBinding[];
    missing: AgentRouteBinding[];
    conflicts: Array<{
        binding: AgentRouteBinding;
        existingAgentId: string;
    }>;
};
export declare function buildChannelBindings(params: {
    agentId: string;
    selection: ChannelChoice[];
    config: OpenClawConfig;
    accountIds?: Partial<Record<ChannelChoice, string>>;
}): AgentRouteBinding[];
export declare function parseBindingSpecs(params: {
    agentId: string;
    specs?: string[];
    config: OpenClawConfig;
}): {
    bindings: AgentRouteBinding[];
    errors: string[];
};
