import type { SandboxToolPolicy } from "./sandbox/types.js";
export declare function isToolAllowedByPolicyName(name: string, policy?: SandboxToolPolicy): boolean;
export declare function isToolAllowedByPolicies(name: string, policies: Array<SandboxToolPolicy | undefined>): boolean;
