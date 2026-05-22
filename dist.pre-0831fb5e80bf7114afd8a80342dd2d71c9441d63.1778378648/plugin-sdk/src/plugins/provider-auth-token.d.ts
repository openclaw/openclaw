export declare const ANTHROPIC_SETUP_TOKEN_PREFIX = "sk-ant-oat01-";
export declare function buildTokenProfileId(params: {
    provider: string;
    name: string;
}): string;
export declare function validateAnthropicSetupToken(raw: string): string | undefined;
