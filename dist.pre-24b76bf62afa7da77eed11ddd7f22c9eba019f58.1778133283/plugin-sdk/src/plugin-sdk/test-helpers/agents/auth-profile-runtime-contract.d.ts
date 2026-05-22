import { type ProviderAuthAliasLookupParams } from "../../../agents/provider-auth-aliases.js";
import type { PluginManifestRegistry } from "../../../plugins/manifest-registry.js";
export declare const AUTH_PROFILE_RUNTIME_CONTRACT: {
    readonly sessionId: "session-auth-contract";
    readonly sessionKey: "agent:main:auth-contract";
    readonly runId: "run-auth-contract";
    readonly workspacePrompt: "continue with the bound Codex profile";
    readonly openAiProvider: "openai";
    readonly openAiCodexProvider: "openai-codex";
    readonly codexCliProvider: "codex-cli";
    readonly codexHarnessProvider: "codex";
    readonly claudeCliProvider: "claude-cli";
    readonly openAiProfileId: "openai:work";
    readonly openAiCodexProfileId: "openai-codex:work";
    readonly anthropicProfileId: "anthropic:work";
};
export declare function createAuthAliasManifestRegistry(): PluginManifestRegistry;
export declare function expectedForwardedAuthProfile(params: {
    provider: string;
    authProfileProvider: string;
    aliasLookupParams: ProviderAuthAliasLookupParams;
    sessionAuthProfileId: string | undefined;
}): string | undefined;
