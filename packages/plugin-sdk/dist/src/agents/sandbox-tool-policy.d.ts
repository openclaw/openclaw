import type { SandboxToolPolicy } from "./sandbox/types.js";
export declare const IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW: unique symbol;
type SandboxToolPolicyConfig = {
    allow?: string[];
    alsoAllow?: string[];
    deny?: string[];
};
export declare function pickSandboxToolPolicy(config?: SandboxToolPolicyConfig): SandboxToolPolicy | undefined;
export {};
