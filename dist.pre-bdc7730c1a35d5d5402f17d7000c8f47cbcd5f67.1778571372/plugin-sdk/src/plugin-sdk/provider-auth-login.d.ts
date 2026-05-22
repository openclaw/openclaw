/**
 * @deprecated Compatibility subpath for provider-owned login helpers.
 * Use provider auth hooks instead of importing bundled provider login commands.
 */
type ProviderAuthLoginRuntime = typeof import("./provider-auth-login.runtime.js");
/** @deprecated GitHub Copilot provider-owned login helper; use provider auth hooks instead. */
export declare const githubCopilotLoginCommand: ProviderAuthLoginRuntime["githubCopilotLoginCommand"];
/** @deprecated Chutes provider-owned login helper; use provider auth hooks instead. */
export declare const loginChutes: ProviderAuthLoginRuntime["loginChutes"];
/** @deprecated OpenAI Codex provider-owned login helper; use provider auth hooks instead. */
export declare const loginOpenAICodexOAuth: ProviderAuthLoginRuntime["loginOpenAICodexOAuth"];
export {};
