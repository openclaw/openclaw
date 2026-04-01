import { useState, useCallback } from "react";

type SessionResult = {
  id: string;
  agentId: string;
  summary: string;
  startedAt: string;
  endedAt?: string;
  toolCalls: number;
  highlights: string[];
};

export function useSessionSearch() {
  const [results, setResults] = useState<SessionResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(async (query: string) => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/mabos/sessions/search?query=${encodeURIComponent(query.trim())}`);
      if (!res.ok) throw new Error("Session search failed");
      const data: SessionResult[] = await res.json();
      setResults(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setResults([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return {
    results,
    isLoading,
    error,
    search,
  };
}
