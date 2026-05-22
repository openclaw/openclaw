import type { DeliveryContext } from "../utils/delivery-context.types.js";
export declare function buildSubagentSystemPrompt(params: {
    requesterSessionKey?: string;
    requesterOrigin?: DeliveryContext;
    childSessionKey: string;
    label?: string;
    task?: string;
    /** Whether ACP-specific routing guidance should be included. Defaults to false. */
    acpEnabled?: boolean;
    /** Registered runtime slash/native command names such as `codex`. */
    nativeCommandNames?: string[];
    /** Plugin-owned prompt guidance for registered native slash commands. */
    nativeCommandGuidanceLines?: string[];
    /** Depth of the child being spawned (1 = sub-agent, 2 = sub-sub-agent). */
    childDepth?: number;
    /** Config value: max allowed spawn depth. */
    maxSpawnDepth?: number;
}): string;
