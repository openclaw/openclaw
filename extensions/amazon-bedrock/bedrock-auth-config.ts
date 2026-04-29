export type BedrockAuthenticationMode = 'apikey' | 'profile' | 'credentials' | 'default';

const VALID_EFFORTS = ['none', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof VALID_EFFORTS)[number];

export interface BedrockAuthConfig {
  awsAuthentication: BedrockAuthenticationMode;
  awsRegion: string;
  awsBedrockApiKey?: string;
  awsProfile?: string;
  awsAccessKey?: string;
  awsSecretKey?: string;
  awsSessionToken?: string;
  awsBedrockEndpoint?: string;
  awsUseCrossRegionInference: boolean;
  awsUseGlobalInference: boolean;
  awsBedrockUsePromptCache: boolean;
  awsBedrockCustomSelected: boolean;
  awsBedrockCustomModelBaseId?: string;
  reasoningEffort?: ReasoningEffort;
  thinkingBudgetTokens?: number;
  enable1MContext: boolean;
}

export interface LegacyBedrockOptions {
  awsUseProfile?: boolean;
  awsAuthentication?: string;
  awsRegion?: string;
  awsBedrockApiKey?: string;
  awsProfile?: string;
  awsAccessKey?: string;
  awsSecretKey?: string;
  awsSessionToken?: string;
  awsBedrockEndpoint?: string;
  awsUseCrossRegionInference?: boolean;
  awsUseGlobalInference?: boolean;
  awsBedrockUsePromptCache?: boolean;
  awsBedrockCustomSelected?: boolean;
  awsBedrockCustomModelBaseId?: string;
  reasoningEffort?: string;
  thinkingBudgetTokens?: number;
  enable1MContext?: boolean;
}

const VALID_MODES: readonly BedrockAuthenticationMode[] = [
  'apikey',
  'profile',
  'credentials',
  'default',
];

/**
 * Resolves the auth mode when `awsAuthentication` is not explicitly set.
 * Precedence matches Cline's resolver:
 *   1. Explicit `awsAuthentication` (if one of the four valid values)
 *   2. Legacy `awsUseProfile: true` → "profile"  (pre-2024 OpenClaw configs)
 *   3. `awsBedrockApiKey` set → "apikey"
 *   4. `awsAccessKey && awsSecretKey` set → "credentials"
 *   5. Fallback → "default" (SDK credential chain)
 *
 * Deliberately asymmetric: `awsUseProfile=true` beats `awsBedrockApiKey`
 * because legacy callers that set `awsUseProfile` expect profile auth to
 * win over anything else in the options bag.
 */
function resolveMode(options: LegacyBedrockOptions): BedrockAuthenticationMode {
  if (
    options.awsAuthentication &&
    VALID_MODES.includes(options.awsAuthentication as BedrockAuthenticationMode)
  ) {
    return options.awsAuthentication as BedrockAuthenticationMode;
  }
  if (options.awsUseProfile) return 'profile';
  if (options.awsBedrockApiKey) return 'apikey';
  if (options.awsAccessKey && options.awsSecretKey) return 'credentials';
  return 'default';
}

export function normalizeBedrockAuthConfig(options: LegacyBedrockOptions): BedrockAuthConfig {
  const mode = resolveMode(options);
  const effort = options.reasoningEffort;
  const isValidEffort = VALID_EFFORTS.includes(effort as ReasoningEffort);

  return {
    awsAuthentication: mode,
    awsRegion: options.awsRegion || 'us-east-1',
    awsBedrockApiKey: options.awsBedrockApiKey,
    awsProfile: options.awsProfile,
    awsAccessKey: options.awsAccessKey,
    awsSecretKey: options.awsSecretKey,
    awsSessionToken: options.awsSessionToken,
    awsBedrockEndpoint: options.awsBedrockEndpoint,
    awsUseCrossRegionInference: options.awsUseCrossRegionInference ?? true,
    awsUseGlobalInference: options.awsUseGlobalInference ?? true,
    awsBedrockUsePromptCache: options.awsBedrockUsePromptCache ?? true,
    awsBedrockCustomSelected: options.awsBedrockCustomSelected ?? false,
    awsBedrockCustomModelBaseId: options.awsBedrockCustomModelBaseId,
    reasoningEffort: isValidEffort ? (effort as ReasoningEffort) : undefined,
    thinkingBudgetTokens: options.thinkingBudgetTokens,
    enable1MContext: options.enable1MContext ?? false,
  };
}
