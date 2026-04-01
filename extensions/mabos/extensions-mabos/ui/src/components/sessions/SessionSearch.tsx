import { Search, X, Loader2, MessageSquare } from "lucide-react";
import { useState, useCallback, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

type SearchResult = {
  id: string;
  sessionTitle: string;
  agent: string;
  relevanceScore: number;
  snippet: string;
};

export function SessionSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ query: q.trim(), limit: "30" });
      const res = await fetch(`/mabos/sessions/search?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: SearchResult[] = await res.json();
      setResults(data);
      setSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }, []);

  function handleInputChange(value: string) {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value), 400);
  }

  function handleClear() {
    setQuery("");
    setResults([]);
    setSearched(false);
    setError(null);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      doSearch(query);
    }
  }

  function scoreColor(score: number): string {
    if (score >= 0.8) return "var(--accent-green)";
    if (score >= 0.5) return "var(--accent-blue)";
    return "var(--accent-orange)";
  }

  return (
    <div className="space-y-4">
      {/* Search input */}
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-lg border"
        style={{
          backgroundColor: "var(--bg-secondary)",
          borderColor: "var(--border-mabos)",
        }}
      >
        {loading ? (
          <Loader2 className="w-4 h-4 text-[var(--text-muted)] animate-spin shrink-0" />
        ) : (
          <Search className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
        )}
        <input
          type="text"
          value={query}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search sessions..."
          className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
        />
        {query && (
          <button
            onClick={handleClear}
            className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Error */}
      {error && <p className="text-xs text-[var(--accent-red)]">{error}</p>}

      {/* Results */}
      {searched && results.length === 0 && !loading && (
        <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] p-6 text-center">
          <MessageSquare className="w-8 h-8 mx-auto mb-2 text-[var(--text-muted)]" />
          <p className="text-sm text-[var(--text-secondary)]">
            No sessions found for &ldquo;{query}&rdquo;
          </p>
        </Card>
      )}

      {results.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-[var(--text-muted)]">
            {results.length} result{results.length !== 1 ? "s" : ""}
          </p>
          {results.map((r) => (
            <Card
              key={r.id}
              className="bg-[var(--bg-card)] border-[var(--border-mabos)] hover:border-[var(--border-hover)] transition-colors p-3 cursor-pointer"
            >
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                      {r.sessionTitle}
                    </span>
                    <Badge variant="outline" className="text-[10px] shrink-0">
                      {r.agent}
                    </Badge>
                  </div>
                  <p className="text-xs text-[var(--text-secondary)] mt-1 line-clamp-2">
                    {r.snippet}
                  </p>
                </div>
                <span
                  className="text-[10px] font-mono font-semibold shrink-0 px-1.5 py-0.5 rounded"
                  style={{
                    backgroundColor: `color-mix(in srgb, ${scoreColor(r.relevanceScore)} 15%, transparent)`,
                    color: scoreColor(r.relevanceScore),
                  }}
                >
                  {Math.round(r.relevanceScore * 100)}%
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
