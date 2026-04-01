import { Search, Sparkles, Loader2 } from "lucide-react";
import { useState, useCallback } from "react";
import { SkillCard } from "./SkillCard";

type MarketplaceSkill = {
  name: string;
  version: string;
  description: string;
  author: string;
  tags: string[];
};

export function SkillMarketplace() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MarketplaceSkill[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);

  const handleSearch = useCallback(async (q: string) => {
    setQuery(q);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setIsLoading(true);
    try {
      const res = await fetch(`/mabos/skills/search?q=${encodeURIComponent(q.trim())}`);
      if (!res.ok) throw new Error("Search failed");
      const data: MarketplaceSkill[] = await res.json();
      setResults(data);
    } catch {
      setResults([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleInstall = useCallback(async (skillName: string) => {
    setInstallingId(skillName);
    try {
      await fetch("/mabos/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: skillName }),
      });
    } finally {
      setInstallingId(null);
    }
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Sparkles size={18} style={{ color: "var(--accent-purple)" }} />
        <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
          Skill Marketplace
        </h2>
      </div>

      {/* Search */}
      <div
        className="flex items-center gap-2 rounded-lg px-3 py-2"
        style={{
          backgroundColor: "var(--bg-secondary)",
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: "var(--border-mabos)",
        }}
      >
        <Search size={14} style={{ color: "var(--text-muted)" }} />
        <input
          type="text"
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Search skills..."
          className="flex-1 bg-transparent text-sm outline-none"
          style={{ color: "var(--text-primary)" }}
        />
        {isLoading && (
          <Loader2 size={14} className="animate-spin" style={{ color: "var(--text-muted)" }} />
        )}
      </div>

      {/* Results grid */}
      {results.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {results.map((skill) => (
            <SkillCard
              key={skill.name}
              name={skill.name}
              version={skill.version}
              description={skill.description}
              author={skill.author}
              tags={skill.tags}
              onInstall={installingId === skill.name ? undefined : () => handleInstall(skill.name)}
            />
          ))}
        </div>
      ) : (
        !isLoading &&
        query.trim() && (
          <p className="text-sm text-center py-8" style={{ color: "var(--text-muted)" }}>
            No skills found for &ldquo;{query}&rdquo;
          </p>
        )
      )}

      {/* Empty state */}
      {!query.trim() && results.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-12">
          <Sparkles size={32} style={{ color: "var(--text-muted)" }} />
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            Search for skills to extend your agent capabilities
          </p>
        </div>
      )}
    </div>
  );
}
