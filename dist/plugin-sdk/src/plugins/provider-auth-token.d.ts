export declare const ANTHROPIC_SETUP_TOKEN_PREFIX = "sk-ant-oat01-";
/** @deprecated Provider-owned setup helper; do not use from third-party plugins. */
export declare function buildTokenProfileId(params: {
    provider: string;
    name: string;
}): string;
/** @deprecated Anthropic provider-owned setup helper; do not use from third-party plugins. */
export declare function validateAnthropicSetupToken(raw: string): string | undefined;
