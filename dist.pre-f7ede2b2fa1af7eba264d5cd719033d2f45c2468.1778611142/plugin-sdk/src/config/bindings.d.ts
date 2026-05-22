import type { AgentAcpBinding, AgentBinding, AgentRouteBinding } from "./types.agents.js";
import type { OpenClawConfig } from "./types.openclaw.js";
export declare function isRouteBinding(binding: AgentBinding): binding is AgentRouteBinding;
export declare function listConfiguredBindings(cfg: OpenClawConfig): AgentBinding[];
export declare function listRouteBindings(cfg: OpenClawConfig): AgentRouteBinding[];
export declare function listAcpBindings(cfg: OpenClawConfig): AgentAcpBinding[];
