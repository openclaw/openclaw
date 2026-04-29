import { describe, expect, it } from 'vitest';
import { normalizeBedrockAuthConfig } from './bedrock-auth-config.js';
import type { BedrockSetupOptions } from './setup-api.js';

describe('normalizeBedrockAuthConfig', () => {
  it('returns defaults when given an empty object', () => {
    const result = normalizeBedrockAuthConfig({});
    expect(result).toEqual({
      awsAuthentication: 'default',
      awsRegion: 'us-east-1',
      awsUseCrossRegionInference: true,
      awsUseGlobalInference: true,
      awsBedrockUsePromptCache: true,
      awsBedrockCustomSelected: false,
      enable1MContext: false,
    });
  });

  it('preserves apikey credentials', () => {
    const result = normalizeBedrockAuthConfig({
      awsAuthentication: 'apikey',
      awsBedrockApiKey: 'sk-abc',
      awsRegion: 'eu-west-1',
    });
    expect(result.awsAuthentication).toBe('apikey');
    expect(result.awsBedrockApiKey).toBe('sk-abc');
    expect(result.awsRegion).toBe('eu-west-1');
  });

  it('preserves profile credentials', () => {
    const result = normalizeBedrockAuthConfig({
      awsAuthentication: 'profile',
      awsProfile: 'work',
    });
    expect(result.awsAuthentication).toBe('profile');
    expect(result.awsProfile).toBe('work');
  });

  it('preserves static credentials', () => {
    const result = normalizeBedrockAuthConfig({
      awsAuthentication: 'credentials',
      awsAccessKey: 'AKIA0000',
      awsSecretKey: 'secret',
      awsSessionToken: 'sess',
    });
    expect(result.awsAuthentication).toBe('credentials');
    expect(result.awsAccessKey).toBe('AKIA0000');
    expect(result.awsSecretKey).toBe('secret');
    expect(result.awsSessionToken).toBe('sess');
  });

  it('migrates legacy awsUseProfile=true to awsAuthentication=profile', () => {
    const result = normalizeBedrockAuthConfig({
      awsUseProfile: true,
      awsProfile: 'legacy',
    });
    expect(result.awsAuthentication).toBe('profile');
    expect(result.awsProfile).toBe('legacy');
  });

  it('rejects unknown awsAuthentication values by falling back to default', () => {
    const result = normalizeBedrockAuthConfig({
      awsAuthentication: 'garbage' as any,
    });
    expect(result.awsAuthentication).toBe('default');
  });
});

describe('normalizeBedrockAuthConfig — coverage gaps', () => {
  it('preserves valid reasoningEffort values', () => {
    for (const effort of ['none', 'low', 'medium', 'high'] as const) {
      const result = normalizeBedrockAuthConfig({ reasoningEffort: effort });
      expect(result.reasoningEffort).toBe(effort);
    }
  });

  it('drops invalid reasoningEffort to undefined', () => {
    const result = normalizeBedrockAuthConfig({ reasoningEffort: 'extreme' });
    expect(result.reasoningEffort).toBeUndefined();
  });

  it('preserves thinkingBudgetTokens and enable1MContext', () => {
    const result = normalizeBedrockAuthConfig({
      thinkingBudgetTokens: 8192,
      enable1MContext: true,
    });
    expect(result.thinkingBudgetTokens).toBe(8192);
    expect(result.enable1MContext).toBe(true);
  });

  it('preserves explicit boolean overrides (false survives the default)', () => {
    const result = normalizeBedrockAuthConfig({
      awsUseCrossRegionInference: false,
      awsUseGlobalInference: false,
      awsBedrockUsePromptCache: false,
    });
    expect(result.awsUseCrossRegionInference).toBe(false);
    expect(result.awsUseGlobalInference).toBe(false);
    expect(result.awsBedrockUsePromptCache).toBe(false);
  });

  it('resolveMode precedence: explicit awsAuthentication wins over inferred', () => {
    const result = normalizeBedrockAuthConfig({
      awsAuthentication: 'default',
      awsBedrockApiKey: 'sk-abc',
      awsUseProfile: true,
    });
    expect(result.awsAuthentication).toBe('default');
  });

  it('resolveMode precedence: awsUseProfile wins over awsBedrockApiKey when both present without explicit mode', () => {
    const result = normalizeBedrockAuthConfig({
      awsUseProfile: true,
      awsBedrockApiKey: 'sk-abc',
      awsProfile: 'work',
    });
    expect(result.awsAuthentication).toBe('profile');
    expect(result.awsBedrockApiKey).toBe('sk-abc'); // field preserved even though mode is profile
  });
});

describe('setup-api re-exports', () => {
  it('exports BedrockSetupOptions as a structural alias of BedrockAuthConfig', () => {
    // Runtime assertion: a normalized config satisfies BedrockSetupOptions shape.
    const config: BedrockSetupOptions = normalizeBedrockAuthConfig({
      awsAuthentication: 'apikey',
      awsBedrockApiKey: 'sk-test',
    });
    expect(config.awsAuthentication).toBe('apikey');
    expect(config.awsBedrockApiKey).toBe('sk-test');
    expect(config.awsRegion).toBe('us-east-1');
  });
});
