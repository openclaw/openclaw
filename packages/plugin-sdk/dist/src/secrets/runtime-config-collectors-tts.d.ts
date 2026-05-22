import { type ResolverContext, type SecretDefaults } from "./runtime-shared.js";
export declare function collectTtsApiKeyAssignments(params: {
    tts: Record<string, unknown>;
    pathPrefix: string;
    defaults: SecretDefaults | undefined;
    context: ResolverContext;
    active?: boolean;
    inactiveReason?: string;
}): void;
