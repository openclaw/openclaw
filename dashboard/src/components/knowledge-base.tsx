"use client";

import { useState, useCallback } from "react";
import { GlassCard } from "@/components/ui/glass-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Search, FileText, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";

interface SearchResult {
  file: string;
  line: number;
  context: string;
}

export function KnowledgeBase() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const search = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setSearched(true);
    try {
      const res = await fetch(`/api/knowledge?q=${encodeURIComponent(query)}`);
      const json = await res.json();
      setResults(json.data || []);
    } catch {
      setResults([]);
    }
    setLoading(false);
  }, [query]);

  return (
    <div className="space-y-4">
      {/* Search bar */}
      <GlassCard padding="sm">
        <div className="flex items-center gap-2">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="Search across all workspace files..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <button
            onClick={search}
            disabled={!query.trim() || loading}
            className={cn(
              "px-3 py-1.5 text-xs font-medium rounded-lg transition-colors",
              query.trim()
                ? "bg-primary text-primary-foreground hover:bg-primary/80"
                : "bg-white/[0.04] text-muted-foreground"
            )}
          >
            {loading ? "Searching..." : "Search"}
          </button>
        </div>
      </GlassCard>

      {/* Results */}
      {!searched ? (
        <GlassCard>
          <EmptyState
            icon={Search}
            title="Search your knowledge base"
            description="Search across all workspace files — AGENTS.md, WORKING.md, memory logs, job listings, and more."
          />
        </GlassCard>
      ) : results.length === 0 ? (
        <GlassCard>
          <EmptyState
            icon={FileText}
            title="No results found"
            description={`No files matching "${query}" in the workspace.`}
          />
        </GlassCard>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{results.length} results</p>
          {results.map((r, i) => (
            <GlassCard key={i} padding="sm" hover>
              <div className="flex items-start gap-2">
                <FileText className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-foreground">{r.file}</span>
                    <span className="flex items-center gap-0.5 text-[9px] text-muted-foreground font-mono">
                      <MapPin className="w-2.5 h-2.5" />
                      L{r.line}
                    </span>
                  </div>
                  <pre className="text-[11px] text-foreground/60 mt-1 whitespace-pre-wrap font-mono leading-relaxed line-clamp-3">
                    {r.context}
                  </pre>
                </div>
              </div>
            </GlassCard>
          ))}
        </div>
      )}
    </div>
  );
}
