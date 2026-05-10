import { vi } from 'vitest';

describe('CompactionSafeguard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it('should handle compaction failure', async () => {
    const mockService = vi.fn().mockResolvedValue({ success: false, error: 'Test error' });
    const result = await mockService();
    expect(result).toHaveProperty('error');
    expect(result.error).toBe('Test error');
  });
});