import type { OpenClawConfig } from "./config.js";
import type { AgentAcpBinding, AgentBinding, AgentRouteBinding } from "./types.agents.js";
export declare function isRouteBinding(binding: AgentBinding): binding is AgentRouteBinding;
export declare function isAcpBinding(binding: AgentBinding): binding is AgentAcpBinding;
export declare function listConfiguredBindings(cfg: OpenClawConfig): AgentBinding[];
export declare function listRouteBindings(cfg: OpenClawConfig): AgentRouteBinding[];
export declare function listAcpBindings(cfg: OpenClawConfig): AgentAcpBinding[];
