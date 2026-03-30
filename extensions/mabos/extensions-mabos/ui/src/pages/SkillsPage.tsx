import { Sparkles, Search, Plus, Play, Tag, Clock } from "lucide-react";
import { useState, useEffect } from "react";

interface Skill {
  name: string;
  version: string;
  description: string;
  author: string;
  tags: string[];
  createdAt: string;
}

export function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/mabos/skills")
      .then((r) => r.json())
      .then((data) => {
        setSkills(data.skills ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const filtered = searchQuery.trim()
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.tags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase())),
      )
    : skills;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
            Skills
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }}>
            Reusable agent workflows created from experience
          </p>
        </div>
        <button
          className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
          style={{ backgroundColor: "var(--accent-purple)", color: "white" }}
        >
          <Plus className="h-4 w-4" /> Create Skill
        </button>
      </div>

      {/* Search */}
      <div
        className="flex items-center gap-3 rounded-lg border px-4 py-2"
        style={{ borderColor: "var(--border-mabos)", backgroundColor: "var(--bg-secondary)" }}
      >
        <Search className="h-4 w-4" style={{ color: "var(--text-secondary)" }} />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search skills by name, description, or tag..."
          className="flex-1 bg-transparent text-sm outline-none"
          style={{ color: "var(--text-primary)" }}
        />
      </div>

      {/* Grid */}
      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-40 rounded-lg animate-pulse"
              style={{ backgroundColor: "var(--bg-secondary)" }}
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div
          className="rounded-lg border p-12 text-center"
          style={{ borderColor: "var(--border-mabos)", backgroundColor: "var(--bg-secondary)" }}
        >
          <Sparkles className="mx-auto h-10 w-10 mb-4" style={{ color: "var(--text-secondary)" }} />
          <h3 className="text-lg font-semibold mb-2" style={{ color: "var(--text-primary)" }}>
            {searchQuery ? "No skills match your search" : "No skills yet"}
          </h3>
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            {searchQuery
              ? "Try a different search term."
              : "Skills are automatically created from successful multi-step agent sessions."}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((skill) => (
            <div
              key={skill.name}
              className="rounded-lg border p-4 transition-colors hover:border-[var(--accent-purple)]"
              style={{ borderColor: "var(--border-mabos)", backgroundColor: "var(--bg-secondary)" }}
            >
              <div className="flex items-start justify-between mb-2">
                <h3 className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>
                  {skill.name}
                </h3>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                  style={{
                    backgroundColor: "color-mix(in srgb, var(--accent-purple) 15%, transparent)",
                    color: "var(--accent-purple)",
                  }}
                >
                  v{skill.version}
                </span>
              </div>
              <p className="text-xs mb-3 line-clamp-2" style={{ color: "var(--text-secondary)" }}>
                {skill.description}
              </p>
              <div className="flex flex-wrap gap-1 mb-3">
                {skill.tags.map((tag) => (
                  <span
                    key={tag}
                    className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded"
                    style={{
                      backgroundColor: "color-mix(in srgb, var(--accent-green) 10%, transparent)",
                      color: "var(--accent-green)",
                    }}
                  >
                    <Tag className="h-2.5 w-2.5" />
                    {tag}
                  </span>
                ))}
              </div>
              <div className="flex items-center justify-between">
                <span
                  className="flex items-center gap-1 text-[10px]"
                  style={{ color: "var(--text-secondary)" }}
                >
                  <Clock className="h-3 w-3" /> {new Date(skill.createdAt).toLocaleDateString()}
                </span>
                <button
                  className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded transition-colors"
                  style={{
                    color: "var(--accent-purple)",
                    backgroundColor: "color-mix(in srgb, var(--accent-purple) 10%, transparent)",
                  }}
                >
                  <Play className="h-3 w-3" /> Run
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
