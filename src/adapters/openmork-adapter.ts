export const OPENMORK_FEATURE_FLAG = false;

export interface OpenMorkConfig {
  baseUrl: string;
  timeoutMs?: number;
  apiKeyEnv?: string;
}

export interface OpenMorkAdapter {
  isReady(): Promise<boolean>;
  complete(input: string): Promise<string>;
  streamComplete(input: string): AsyncGenerator<string, void, unknown>;
}

class OpenMorkAdapterImpl implements OpenMorkAdapter {
  constructor(private readonly config: OpenMorkConfig) {}

  async isReady(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 3000);
      try {
        const res = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/health`, {
          method: 'GET',
          signal: controller.signal,
        });
        return res.ok;
      } finally {
        clearTimeout(t);
      }
    } catch {
      return false;
    }
  }

  async complete(_input: string): Promise<string> {
    throw new Error('OpenMork adapter skeleton only: complete() not implemented yet');
  }

  async *streamComplete(_input: string): AsyncGenerator<string, void, unknown> {
    throw new Error('OpenMork adapter skeleton only: streamComplete() not implemented yet');
  }
}

export function createOpenMorkAdapter(config: OpenMorkConfig): OpenMorkAdapter {
  return new OpenMorkAdapterImpl(config);
}
