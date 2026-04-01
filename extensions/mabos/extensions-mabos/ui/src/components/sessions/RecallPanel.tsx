import { Brain, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

type RecallMessage = {
  role: string;
  content: string;
  timestamp: string;
};

type RecallResult = {
  sessionId: string;
  sessionTitle: string;
  score: number;
  messages: RecallMessage[];
};

type RecallPanelProps = {
  query: string;
};

export function RecallPanel({ query }: RecallPanelProps) {
  const [results, setResults] = useState<RecallResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }

    let cancelled = false;

    async function fetchRecall() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/mabos/sessions/recall", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: query.trim(), limit: 5 }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: RecallResult[] = await res.json();
        if (!cancelled) {
          setResults(data);
          // Auto-expand the first result
          if (data.length > 0) {
            setExpandedSessions(new Set([data[0].sessionId]));
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Recall failed");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchRecall();
    return () => {
      cancelled = true;
    };
  }, [query]);

  function toggleSession(sessionId: string) {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  if (!query.trim()) {
    return (
      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] p-6 text-center">
        <Brain className="w-8 h-8 mx-auto mb-2 text-[var(--text-muted)]" />
        <p className="text-sm text-[var(--text-secondary)]">
          Enter a query to recall cross-session context
        </p>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] p-6 text-center">
        <Loader2 className="w-6 h-6 mx-auto mb-2 text-[var(--accent-purple)] animate-spin" />
        <p className="text-sm text-[var(--text-secondary)]">Searching memory...</p>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] p-6">
        <p className="text-sm text-[var(--accent-red)]">{error}</p>
      </Card>
    );
  }

  if (results.length === 0) {
    return (
      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] p-6 text-center">
        <Brain className="w-8 h-8 mx-auto mb-2 text-[var(--text-muted)]" />
        <p className="text-sm text-[var(--text-secondary)]">No recall results found</p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--text-muted)]">
        {results.length} session{results.length !== 1 ? "s" : ""} recalled
      </p>
      {results.map((result) => {
        const expanded = expandedSessions.has(result.sessionId);
        return (
          <Card
            key={result.sessionId}
            className="bg-[var(--bg-card)] border-[var(--border-mabos)] overflow-hidden"
          >
            {/* Session header */}
            <button
              onClick={() => toggleSession(result.sessionId)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--bg-secondary)] transition-colors"
            >
              {expanded ? (
                <ChevronDown className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
              ) : (
                <ChevronRight className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
              )}
              <span className="text-sm font-medium text-[var(--text-primary)] truncate flex-1">
                {result.sessionTitle}
              </span>
              <Badge
                variant="outline"
                className="text-[10px] shrink-0"
                style={{
                  borderColor: "var(--accent-purple)",
                  color: "var(--accent-purple)",
                }}
              >
                {Math.round(result.score * 100)}% match
              </Badge>
            </button>

            {/* Messages */}
            {expanded && (
              <div className="border-t border-[var(--border-mabos)] px-4 py-3 space-y-2">
                {result.messages.map((msg, idx) => (
                  <div key={idx} className="flex gap-2">
                    <span
                      className="text-[10px] font-mono font-semibold uppercase shrink-0 mt-0.5 px-1.5 py-0.5 rounded"
                      style={{
                        backgroundColor:
                          msg.role === "user"
                            ? "color-mix(in srgb, var(--accent-blue) 15%, transparent)"
                            : "color-mix(in srgb, var(--accent-green) 15%, transparent)",
                        color: msg.role === "user" ? "var(--accent-blue)" : "var(--accent-green)",
                      }}
                    >
                      {msg.role}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-words">
                        {msg.content}
                      </p>
                      <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
                        {new Date(msg.timestamp).toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
