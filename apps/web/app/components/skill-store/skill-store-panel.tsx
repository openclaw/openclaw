"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";

type SkillStoreTab = "installed" | "browse";

type InstalledSkill = {
  name: string;
  slug: string;
  description: string;
  emoji?: string;
  source: string;
  filePath: string;
  protected: boolean;
};

type BrowseSkill = {
  slug: string;
  displayName: string;
  summary: string;
  installs: number;
  source: string;
};

const TABS: { id: SkillStoreTab; label: string }[] = [
  { id: "installed", label: "Installed" },
  { id: "browse", label: "Browse" },
];

export function SkillStorePanel({ embedded }: { embedded?: boolean } = {}) {
  const [activeTab, setActiveTab] = useState<SkillStoreTab>("installed");
  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [removingSlug, setRemovingSlug] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  // Browse state
  const [browseSkills, setBrowseSkills] = useState<BrowseSkill[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [browseQuery, setBrowseQuery] = useState("");
  const browseDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);
  // Keep a fast local lookup so Browse cards can reflect install state immediately.
  const [installedSlugs, setInstalledSlugs] = useState<Set<string>>(new Set());

  const fetchInstalled = useCallback(async () => {
    try {
      const res = await fetch("/api/skills");
      const data = await res.json();
      const skills: InstalledSkill[] = data.skills ?? [];
      setInstalledSkills(skills);
      setInstalledSlugs(new Set(skills.map((s) => s.slug)));
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchInstalled();
  }, [fetchInstalled]);

  const fetchBrowse = useCallback(async (query?: string) => {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const params = new URLSearchParams();
      if (query?.trim()) params.set("q", query.trim());
      const res = await fetch(`/api/skills/browse?${params.toString()}`);
      const data = await res.json();
      if (data.error) setBrowseError(data.error);
      setBrowseSkills(data.skills ?? []);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : "Failed to load skills");
      setBrowseSkills([]);
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === "browse" && browseSkills.length === 0 && !browseLoading && !browseError) {
      void fetchBrowse();
    }
  }, [activeTab, browseSkills.length, browseLoading, browseError, fetchBrowse]);

  const handleBrowseSearch = useCallback((value: string) => {
    setBrowseQuery(value);
    clearTimeout(browseDebounce.current);
    // Debounce remote search so typing does not hammer the skills search proxy route.
    browseDebounce.current = setTimeout(() => {
      void fetchBrowse(value);
    }, 300);
  }, [fetchBrowse]);

  const handleRemove = useCallback(async (slug: string) => {
    setRemovingSlug(slug);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(slug)}`, { method: "DELETE" });
      const data = await res.json();
      if (data.ok) {
        setInstalledSkills((prev) => prev.filter((s) => s.slug !== slug));
        setInstalledSlugs((prev) => { const n = new Set(prev); n.delete(slug); return n; });
      }
    } catch {
      // ignore
    } finally {
      setRemovingSlug(null);
      setConfirmRemove(null);
    }
  }, []);

  const handleInstall = useCallback(async (skill: BrowseSkill) => {
    setInstallingSlug(skill.slug);
    try {
      const res = await fetch("/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: skill.slug, source: skill.source }),
      });
      const data = await res.json();
      if (data.ok) {
        // Update Browse card state immediately, then refresh Installed with full metadata.
        setInstalledSlugs((prev) => new Set(prev).add(skill.slug));
        void fetchInstalled();
      }
    } catch {
      // ignore
    } finally {
      setInstallingSlug(null);
    }
  }, [fetchInstalled]);

  const filteredInstalled = useMemo(() => {
    if (!searchQuery.trim()) return installedSkills;
    const q = searchQuery.toLowerCase();
    return installedSkills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [installedSkills, searchQuery]);

  return (
    <div className={embedded ? "" : "p-6 max-w-5xl mx-auto"}>
      {!embedded && (
        <div className="flex items-end justify-between mb-6">
          <div>
            <h1
              className="font-instrument text-3xl tracking-tight mb-1"
              style={{ color: "var(--color-text)" }}
            >
              Skill Store
            </h1>
            <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
              {installedSkills.length} skill{installedSkills.length !== 1 ? "s" : ""} installed
            </p>
          </div>
        </div>
      )}

      {/* Tab bar */}
      <div
        className="flex w-fit items-center gap-1 mb-6 rounded-xl p-1"
        style={{ background: "var(--color-surface-hover)" }}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className="px-4 py-1.5 rounded-lg text-sm font-medium transition-all cursor-pointer"
            style={{
              background: activeTab === tab.id ? "var(--color-surface)" : "transparent",
              color: activeTab === tab.id ? "var(--color-text)" : "var(--color-text-muted)",
              boxShadow: activeTab === tab.id ? "var(--shadow-sm)" : "none",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="mb-4">
        <input
          type="text"
          value={activeTab === "installed" ? searchQuery : browseQuery}
          onChange={(e) =>
            activeTab === "installed"
              ? setSearchQuery(e.target.value)
              : handleBrowseSearch(e.target.value)
          }
          placeholder={activeTab === "installed" ? "Filter installed skills..." : "Search skills..."}
          className="w-full px-3 py-2 rounded-xl text-sm outline-none"
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
          }}
        />
      </div>

      {activeTab === "installed" && (
        <InstalledTab
          skills={filteredInstalled}
          loading={loading}
          removingSlug={removingSlug}
          confirmRemove={confirmRemove}
          onConfirmRemove={setConfirmRemove}
          onRemove={handleRemove}
        />
      )}

      {activeTab === "browse" && (
        <BrowseTab
          skills={browseSkills}
          loading={browseLoading}
          error={browseError}
          installedSlugs={installedSlugs}
          installingSlug={installingSlug}
          onInstall={handleInstall}
          onRetry={() => void fetchBrowse(browseQuery)}
        />
      )}
    </div>
  );
}

function InstalledTab({
  skills,
  loading,
  removingSlug,
  confirmRemove,
  onConfirmRemove,
  onRemove,
}: {
  skills: InstalledSkill[];
  loading: boolean;
  removingSlug: string | null;
  confirmRemove: string | null;
  onConfirmRemove: (slug: string | null) => void;
  onRemove: (slug: string) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div
          className="w-6 h-6 border-2 rounded-full animate-spin"
          style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }}
        />
      </div>
    );
  }

  if (skills.length === 0) {
    return (
      <div
        className="p-8 text-center rounded-2xl"
        style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
      >
        <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
          No installed skills found.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {skills.map((skill) => (
        <div
          key={skill.slug}
          className="rounded-2xl p-4 flex flex-col gap-2"
          style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {skill.emoji && <span className="text-lg flex-shrink-0">{skill.emoji}</span>}
              <div className="min-w-0">
                <div className="text-sm font-medium truncate" style={{ color: "var(--color-text)" }}>
                  {skill.name}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded-full"
                    style={{
                      background: skill.source === "managed"
                        ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
                        : "var(--color-surface-hover)",
                      color: skill.source === "managed"
                        ? "var(--color-accent)"
                        : "var(--color-text-muted)",
                    }}
                  >
                    {skill.source}
                  </span>
                  {skill.protected && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-1"
                      style={{
                        background: "color-mix(in srgb, var(--color-warning, #f59e0b) 12%, transparent)",
                        color: "var(--color-warning, #f59e0b)",
                      }}
                      title="This skill is required by DenchClaw"
                    >
                      <LockIcon />
                      protected
                    </span>
                  )}
                </div>
              </div>
            </div>
            {!skill.protected && (
              <div className="flex-shrink-0">
                {confirmRemove === skill.slug ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onRemove(skill.slug)}
                      disabled={removingSlug === skill.slug}
                      className="text-[11px] px-2 py-1 rounded-lg cursor-pointer transition-colors"
                      style={{
                        background: "color-mix(in srgb, var(--color-error, #ef4444) 12%, transparent)",
                        color: "var(--color-error, #ef4444)",
                      }}
                    >
                      {removingSlug === skill.slug ? (
                        <span className="flex items-center gap-1">
                          <span
                            className="w-3 h-3 border border-current rounded-full animate-spin"
                            style={{ borderTopColor: "transparent" }}
                          />
                          Removing...
                        </span>
                      ) : (
                        "Confirm"
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => onConfirmRemove(null)}
                      className="text-[11px] px-2 py-1 rounded-lg cursor-pointer"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => onConfirmRemove(skill.slug)}
                    className="text-[11px] px-2 py-1 rounded-lg cursor-pointer transition-colors"
                    style={{ color: "var(--color-text-muted)" }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.background = "color-mix(in srgb, var(--color-error, #ef4444) 8%, transparent)";
                      (e.currentTarget as HTMLElement).style.color = "var(--color-error, #ef4444)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.background = "transparent";
                      (e.currentTarget as HTMLElement).style.color = "var(--color-text-muted)";
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            )}
          </div>
          {skill.description && (
            <p className="text-xs leading-relaxed line-clamp-2" style={{ color: "var(--color-text-muted)" }}>
              {skill.description}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function BrowseTab({
  skills,
  loading,
  error,
  installedSlugs,
  installingSlug,
  onInstall,
  onRetry,
}: {
  skills: BrowseSkill[];
  loading: boolean;
  error: string | null;
  installedSlugs: Set<string>;
  installingSlug: string | null;
  onInstall: (skill: BrowseSkill) => void;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div
          className="w-6 h-6 border-2 rounded-full animate-spin"
          style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }}
        />
      </div>
    );
  }

  if (error && skills.length === 0) {
    return (
      <div
        className="p-8 text-center rounded-2xl"
        style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
      >
        <p className="text-sm mb-3" style={{ color: "var(--color-text-muted)" }}>
          Could not load skills
        </p>
        <p className="text-xs mb-4" style={{ color: "var(--color-text-muted)" }}>{error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="text-xs px-3 py-1.5 rounded-lg cursor-pointer"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-bg)",
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (skills.length === 0) {
    return (
      <div
        className="p-8 text-center rounded-2xl"
        style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
      >
        <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
          No skills found.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {skills.map((skill) => {
        const isInstalled = installedSlugs.has(skill.slug);
        const isInstalling = installingSlug === skill.slug;
        return (
          <div
            key={skill.slug}
            className="rounded-2xl p-4 flex flex-col gap-2"
            style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate" style={{ color: "var(--color-text)" }}>
                  {skill.displayName}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  {skill.source && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded-full"
                      style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
                      title={skill.source}
                    >
                      {skill.source}
                    </span>
                  )}
                  {skill.installs > 0 && (
                    <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
                      <DownloadIcon /> {skill.installs.toLocaleString()}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex-shrink-0">
                {isInstalled ? (
                  <span
                    className="text-[11px] px-2 py-1 rounded-lg"
                    style={{
                      background: "color-mix(in srgb, var(--color-success, #22c55e) 12%, transparent)",
                      color: "var(--color-success, #22c55e)",
                    }}
                  >
                    Installed
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onInstall(skill)}
                    disabled={isInstalling}
                    className="text-[11px] px-2.5 py-1 rounded-lg cursor-pointer transition-colors"
                    style={{
                      background: "var(--color-accent)",
                      color: "var(--color-bg)",
                      opacity: isInstalling ? 0.7 : 1,
                    }}
                  >
                    {isInstalling ? (
                      <span className="flex items-center gap-1">
                        <span
                          className="w-3 h-3 border border-current rounded-full animate-spin"
                          style={{ borderTopColor: "transparent" }}
                        />
                        Installing...
                      </span>
                    ) : (
                      "Install"
                    )}
                  </button>
                )}
              </div>
            </div>
            {skill.summary && (
              <p className="text-xs leading-relaxed line-clamp-2" style={{ color: "var(--color-text-muted)" }}>
                {skill.summary}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: "inline", verticalAlign: "middle" }}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
