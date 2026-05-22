import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { NodeSession } from "./node-registry.js";
export declare const DEFAULT_DANGEROUS_NODE_COMMANDS: string[];
export declare function listDangerousPluginNodeCommands(): string[];
export declare function resolveNodeCommandAllowlist(cfg: OpenClawConfig, node?: Pick<NodeSession, "platform" | "deviceFamily">): Set<string>;
export declare function normalizeDeclaredNodeCommands(params: {
    declaredCommands?: readonly string[];
    allowlist: Set<string>;
}): string[];
export declare function isNodeCommandAllowed(params: {
    command: string;
    declaredCommands?: string[];
    allowlist: Set<string>;
}): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
