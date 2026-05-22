import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundIdentity } from "./identity-types.js";
export type { OutboundIdentity } from "./identity-types.js";
export declare function normalizeOutboundIdentity(identity?: OutboundIdentity | null): OutboundIdentity | undefined;
export declare function resolveAgentOutboundIdentity(cfg: OpenClawConfig, agentId: string): OutboundIdentity | undefined;
