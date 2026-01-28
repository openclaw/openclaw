import type { SearchResult, Observation } from "./types.js";

export class ClaudeMemClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeout: number,
  ) {}

  async ping(): Promise<boolean> {
    // TODO: Phase 3
    return false;
  }

  async observe(
    sessionId: string,
    toolName: string,
    toolInput: unknown,
    toolResponse: unknown,
  ): Promise<void> {
    // TODO: Phase 3
  }

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    // TODO: Phase 3
    return [];
  }

  async getObservations(ids: number[]): Promise<Observation[]> {
    // TODO: Phase 3
    return [];
  }
}
