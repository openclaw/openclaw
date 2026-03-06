export declare const ANTHROPIC_SETUP_TOKEN_PREFIX = "sk-ant-oat01-";
export declare const ANTHROPIC_SETUP_TOKEN_MIN_LENGTH = 80;
export declare const DEFAULT_TOKEN_PROFILE_NAME = "default";
export declare function normalizeTokenProfileName(raw: string): string;
export declare function buildTokenProfileId(params: {
    provider: string;
    name: string;
}): string;
export declare function validateAnthropicSetupToken(raw: string): string | undefined;
