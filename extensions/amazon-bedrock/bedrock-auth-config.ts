export type BedrockAuthenticationMode = 'apikey' | 'profile' | 'credentials' | 'default';

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
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
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
  const isValidEffort =
    effort === 'none' || effort === 'low' || effort === 'medium' || effort === 'high';

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
    reasoningEffort: isValidEffort ? (effort as 'none' | 'low' | 'medium' | 'high') : undefined,
    thinkingBudgetTokens: options.thinkingBudgetTokens,
    enable1MContext: options.enable1MContext ?? false,
  };
}
