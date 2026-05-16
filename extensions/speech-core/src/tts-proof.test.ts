import { describe, it, expect, vi } from 'vitest';
import type { SpeechProviderPlugin } from '../../src/tts/provider-types';

const mockProvider = {
  id: 'elevenlabs',
  label: 'ElevenLabs',
  synthesize: vi.fn().mockResolvedValue({
    audioBuffer: Buffer.from('mock-audio'),
    outputFormat: 'mp3_44100_128',
    fileExtension: '.mp3',
    voiceCompatible: true,
    wordTimestamps: {
      characters: ['H', 'e', 'l', 'l', 'o'],
      characterStartTimesSeconds: [0.0, 0.1, 0.2, 0.3, 0.4],
      characterEndTimesSeconds: [0.1, 0.2, 0.3, 0.4, 0.5],
    },
  }),
  dispose: vi.fn(),
} as unknown as SpeechProviderPlugin;

describe('TTS Timestamp Propagation', () => {
  it('should propagate word timestamps from provider to synthesis result', async () => {
    const { synthesizeSpeech } = await import('./tts');
    const result = await synthesizeSpeech({
      text: 'Hello',
      target: 'audio-file',
      provider: mockProvider,
      overrides: {},
    });

    expect(result.wordTimestamps).toBeDefined();
    expect(result.wordTimestamps?.characters).toEqual(['H', 'e', 'l', 'l', 'o']);
    expect(result.wordTimestamps?.characterStartTimesSeconds).toEqual([0.0, 0.1, 0.2, 0.3, 0.4]);
    expect(result.wordTimestamps?.characterEndTimesSeconds).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
  });
});
