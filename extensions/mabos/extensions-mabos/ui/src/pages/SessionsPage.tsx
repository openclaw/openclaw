import { FileSearch, Search, MessageSquare, Clock, User } from "lucide-react";
import { useState } from "react";

interface SearchResult {
  sessionId: string;
  sessionTitle: string | null;
  agentId: string;
  content: string;
  role: string;
  timestamp: number;
}

export function SessionsPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const resp = await fetch(
        `/mabos/sessions/search?query=${encodeURIComponent(query)}&limit=30`,
      );
      const data = await resp.json();
      setResults(data.results ?? []);
    } catch {
      setResults([]);
    }
    setLoading(false);
    setSearched(true);
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
          Session Search
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }}>
          Full-text search across all past agent conversations
        </p>
      </div>

      {/* Search bar */}
      <div className="flex gap-2">
        <div
          className="flex flex-1 items-center gap-3 rounded-lg border px-4 py-2"
          style={{ borderColor: "var(--border-mabos)", backgroundColor: "var(--bg-secondary)" }}
        >
          <Search className="h-4 w-4 shrink-0" style={{ color: "var(--text-secondary)" }} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="Search past sessions (e.g., 'revenue target', 'shopify launch')..."
            className="flex-1 bg-transparent text-sm outline-none"
            style={{ color: "var(--text-primary)" }}
          />
        </div>
        <button
          onClick={handleSearch}
          disabled={loading}
          className="rounded-lg px-4 py-2 text-sm font-medium transition-colors"
          style={{
            backgroundColor: "var(--accent-purple)",
            color: "white",
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? "Searching..." : "Search"}
        </button>
      </div>

      {/* Results */}
      {!searched ? (
        <div
          className="rounded-lg border p-12 text-center"
          style={{ borderColor: "var(--border-mabos)", backgroundColor: "var(--bg-secondary)" }}
        >
          <FileSearch
            className="mx-auto h-10 w-10 mb-4"
            style={{ color: "var(--text-secondary)" }}
          />
          <h3 className="text-lg font-semibold mb-2" style={{ color: "var(--text-primary)" }}>
            Search past sessions
          </h3>
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            Find relevant context from past agent conversations using full-text search.
          </p>
        </div>
      ) : results.length === 0 ? (
        <div
          className="rounded-lg border p-8 text-center"
          style={{ borderColor: "var(--border-mabos)", backgroundColor: "var(--bg-secondary)" }}
        >
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            No results found for "{query}".
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            {results.length} results
          </p>
          {results.map((r, i) => (
            <div
              key={i}
              className="rounded-lg border p-4"
              style={{ borderColor: "var(--border-mabos)", backgroundColor: "var(--bg-secondary)" }}
            >
              <div className="flex items-center gap-3 mb-2">
                <span
                  className="flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded"
                  style={{
                    backgroundColor: "color-mix(in srgb, var(--accent-purple) 15%, transparent)",
                    color: "var(--accent-purple)",
                  }}
                >
                  <User className="h-3 w-3" /> {r.agentId}
                </span>
                <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                  {r.sessionTitle ?? r.sessionId}
                </span>
                <span
                  className="flex items-center gap-1 text-[10px] ml-auto"
                  style={{ color: "var(--text-secondary)" }}
                >
                  <Clock className="h-3 w-3" /> {new Date(r.timestamp).toLocaleString()}
                </span>
              </div>
              <div className="flex items-start gap-2">
                <MessageSquare
                  className="h-3.5 w-3.5 mt-0.5 shrink-0"
                  style={{ color: "var(--text-secondary)" }}
                />
                <p className="text-sm leading-relaxed" style={{ color: "var(--text-primary)" }}>
                  <span className="font-medium">{r.role}:</span> {r.content.slice(0, 300)}
                  {r.content.length > 300 ? "..." : ""}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
