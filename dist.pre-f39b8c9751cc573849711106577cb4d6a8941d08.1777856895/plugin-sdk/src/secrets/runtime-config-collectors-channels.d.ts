import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type ResolverContext, type SecretDefaults } from "./runtime-shared.js";
export declare function collectChannelConfigAssignments(params: {
    config: OpenClawConfig;
    defaults: SecretDefaults | undefined;
    context: ResolverContext;
}): void;
