import type { SessionIndex } from "./session-index.js";
import type { RecallResult } from "./types.js";

export class SessionRecall {
  constructor(private index: SessionIndex) {}

  async recall(params: {
    query: string;
    agentId?: string;
    companyId?: string;
    limit?: number;
  }): Promise<RecallResult[]> {
    const results = this.index.search(params.query, {
      agentId: params.agentId,
      companyId: params.companyId,
      limit: (params.limit ?? 5) * 4, // Fetch more for grouping
    });

    // Group by session
    const sessionMap = new Map<string, RecallResult>();
    for (const r of results) {
      let session = sessionMap.get(r.sessionId);
      if (!session) {
        session = {
          sessionId: r.sessionId,
          sessionTitle: r.sessionTitle,
          agentId: r.agentId,
          messages: [],
          relevance: r.relevance,
        };
        sessionMap.set(r.sessionId, session);
      }
      session.messages.push({ role: r.role, content: r.content, timestamp: r.timestamp });
      // Keep best (most negative = most relevant) rank
      if (r.relevance < session.relevance) session.relevance = r.relevance;
    }

    // Sort by relevance and limit
    return Array.from(sessionMap.values())
      .sort((a, b) => a.relevance - b.relevance)
      .slice(0, params.limit ?? 5);
  }
}
