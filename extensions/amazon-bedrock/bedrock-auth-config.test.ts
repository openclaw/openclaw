import { describe, expect, it } from 'vitest';
import { normalizeBedrockAuthConfig } from './bedrock-auth-config.js';

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
