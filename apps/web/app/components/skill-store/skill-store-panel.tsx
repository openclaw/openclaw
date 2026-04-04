"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  InstalledSkillCard,
  BrowseSkillCard,
  StatusNotice,
  type InstalledSkillData,
  type BrowseSkillData,
  type InstallStatus,
} from "./skill-card";

type SkillStoreTab = "installed" | "browse";

type PanelNotice = {
  tone: "info" | "success" | "error";
  text: string;
};

const TABS: { id: SkillStoreTab; label: string; icon: () => React.JSX.Element }[] = [
  { id: "installed", label: "Installed", icon: PackageIcon },
  { id: "browse", label: "Browse", icon: CompassIcon },
];

export function SkillStorePanel({ embedded }: { embedded?: boolean } = {}) {
  const [activeTab, setActiveTab] = useState<SkillStoreTab>("installed");
  const [serverInstalledSkills, setServerInstalledSkills] = useState<InstalledSkillData[]>([]);
  const [optimisticInstalledSkills, setOptimisticInstalledSkills] = useState<Record<string, InstalledSkillData>>({});
  const [loading, setLoading] = useState(true);
  const [installedRefreshing, setInstalledRefreshing] = useState(false);
  const [installedError, setInstalledError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [removingSlug, setRemovingSlug] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const [browseSkills, setBrowseSkills] = useState<BrowseSkillData[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [browseQuery, setBrowseQuery] = useState("");
  const browseDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const browseAbort = useRef<AbortController | null>(null);
  const browseInitialised = useRef(false);
  const [installStatuses, setInstallStatuses] = useState<Record<string, InstallStatus>>({});
  const [panelNotice, setPanelNotice] = useState<PanelNotice | null>(null);

  const [featuredSkills, setFeaturedSkills] = useState<BrowseSkillData[]>([]);
  const featuredInitialised = useRef(false);
  const [featuredLoading, setFeaturedLoading] = useState(false);
  const [categories, setCategories] = useState<string[]>([]);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const [detailSkill, setDetailSkill] = useState<InstalledSkillData | null>(null);
  const [detailContent, setDetailContent] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const installedSkills = useMemo(() => {
    const merged = new Map<string, InstalledSkillData>();
    for (const skill of serverInstalledSkills) merged.set(skill.slug, skill);
    for (const skill of Object.values(optimisticInstalledSkills)) {
      if (!merged.has(skill.slug)) merged.set(skill.slug, skill);
    }
    return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [optimisticInstalledSkills, serverInstalledSkills]);

  const installedSlugs = useMemo(
    () => new Set(installedSkills.map((s) => s.slug)),
    [installedSkills],
  );

  const fetchInstalled = useCallback(async ({ showSpinner = false } = {}): Promise<boolean> => {
    if (showSpinner) setLoading(true);
    else setInstalledRefreshing(true);
    setInstalledError(null);
    try {
      const res = await fetch("/api/skills");
      if (!res.ok) throw new Error(`Failed to load installed skills (${res.status})`);
      const data = await res.json();
      const skills: InstalledSkillData[] = data.skills ?? [];
      setServerInstalledSkills(skills);
      setOptimisticInstalledSkills((prev) => {
        if (Object.keys(prev).length === 0) return prev;
        const next = { ...prev };
        for (const s of skills) delete next[s.slug];
        return next;
      });
      return true;
    } catch (err) {
      setInstalledError(err instanceof Error ? err.message : "Failed to load installed skills");
      return false;
    } finally {
      if (showSpinner) setLoading(false);
      setInstalledRefreshing(false);
    }
  }, []);

  useEffect(() => { void fetchInstalled({ showSpinner: true }); }, [fetchInstalled]);

  const fetchBrowse = useCallback(async (query?: string, category?: string | null) => {
    browseAbort.current?.abort();
    const controller = new AbortController();
    browseAbort.current = controller;
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const params = new URLSearchParams();
      if (query?.trim()) params.set("q", query.trim());
      else if (category) params.set("category", category);
      const res = await fetch(`/api/skills/browse?${params.toString()}`, { signal: controller.signal });
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (data.error) setBrowseError(data.error);
      setBrowseSkills(data.skills ?? []);
      if (data.categories) setCategories(data.categories);
    } catch (err) {
      if (controller.signal.aborted) return;
      setBrowseError(err instanceof Error ? err.message : "Failed to load skills");
      setBrowseSkills([]);
    } finally {
      if (!controller.signal.aborted) setBrowseLoading(false);
    }
  }, []);

  const fetchFeatured = useCallback(async () => {
    setFeaturedLoading(true);
    try {
      const res = await fetch("/api/skills/browse?featured=true");
      const data = await res.json();
      setFeaturedSkills(data.skills ?? []);
      if (data.categories) setCategories(data.categories);
    } catch {
      setFeaturedSkills([]);
    } finally {
      setFeaturedLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === "browse" && !featuredInitialised.current && !featuredLoading) {
      featuredInitialised.current = true;
      void fetchFeatured();
    }
    if (activeTab === "browse" && !browseInitialised.current && !browseLoading) {
      browseInitialised.current = true;
      void fetchBrowse();
    }
  }, [activeTab, featuredLoading, browseLoading, fetchBrowse, fetchFeatured]);

  const handleBrowseSearch = useCallback((value: string) => {
    setBrowseQuery(value);
    clearTimeout(browseDebounce.current);
    browseDebounce.current = setTimeout(() => {
      void fetchBrowse(value, activeCategory);
    }, 300);
  }, [fetchBrowse, activeCategory]);

  const handleCategoryClick = useCallback((cat: string | null) => {
    setActiveCategory(cat);
    setBrowseQuery("");
    void fetchBrowse("", cat);
  }, [fetchBrowse]);

  const handleRemove = useCallback(async (slug: string) => {
    setRemovingSlug(slug);
    setPanelNotice(null);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(slug)}`, { method: "DELETE" });
      const data = await res.json();
      if (data.ok) {
        setServerInstalledSkills((prev) => prev.filter((s) => s.slug !== slug));
        setOptimisticInstalledSkills((prev) => {
          if (!(slug in prev)) return prev;
          const next = { ...prev };
          delete next[slug];
          return next;
        });
        setInstallStatuses((prev) => {
          if (!(slug in prev)) return prev;
          const next = { ...prev };
          delete next[slug];
          return next;
        });
        setPanelNotice({ tone: "success", text: `Removed ${slug}.` });
        if (detailSkill?.slug === slug) setDetailSkill(null);
      } else {
        setPanelNotice({ tone: "error", text: data.error ?? `Failed to remove ${slug}.` });
      }
    } catch (err) {
      setPanelNotice({ tone: "error", text: err instanceof Error ? err.message : `Failed to remove ${slug}.` });
    } finally {
      setRemovingSlug(null);
      setConfirmRemove(null);
    }
  }, [detailSkill?.slug]);

  const handleInstall = useCallback(async (skill: BrowseSkillData) => {
    setPanelNotice({ tone: "info", text: `Installing ${skill.displayName}...` });
    setInstallStatuses((prev) => ({
      ...prev,
      [skill.slug]: { phase: "installing", message: `Installing ${skill.displayName}...` },
    }));
    try {
      const res = await fetch("/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: skill.slug, source: skill.source }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `Failed to install ${skill.displayName}`);

      const installedSkill: InstalledSkillData = data.skill ?? {
        name: skill.displayName,
        slug: skill.slug,
        description: skill.summary,
        source: "skills.sh",
        filePath: "",
        protected: false,
      };

      setOptimisticInstalledSkills((prev) => ({ ...prev, [installedSkill.slug]: installedSkill }));
      setInstallStatuses((prev) => ({
        ...prev,
        [skill.slug]: { phase: "refreshing", message: "Refreshing installed skills..." },
      }));
      setPanelNotice({ tone: "info", text: `Installed ${skill.displayName}. Refreshing the Installed list...` });

      const refreshed = await fetchInstalled();
      if (refreshed) {
        setInstallStatuses((prev) => ({
          ...prev,
          [skill.slug]: { phase: "success", message: `${skill.displayName} installed successfully.` },
        }));
        setPanelNotice({ tone: "success", text: `${skill.displayName} is now installed.` });
      } else {
        setInstallStatuses((prev) => ({
          ...prev,
          [skill.slug]: { phase: "success", message: `${skill.displayName} was installed, but the Installed list could not be refreshed.` },
        }));
        setPanelNotice({ tone: "info", text: `${skill.displayName} was installed, but we could not refresh the Installed list automatically.` });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : `Failed to install ${skill.displayName}`;
      setInstallStatuses((prev) => ({ ...prev, [skill.slug]: { phase: "error", message } }));
      setPanelNotice({ tone: "error", text: message });
    }
  }, [fetchInstalled]);

  const handleSkillClick = useCallback(async (skill: InstalledSkillData) => {
    setDetailSkill(skill);
    setDetailContent(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skill.slug)}/content`);
      if (res.ok) {
        const data = await res.json();
        setDetailContent(data.content ?? null);
      }
    } catch {
      // content fetch is best-effort
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const filteredInstalled = useMemo(() => {
    if (!searchQuery.trim()) return installedSkills;
    const q = searchQuery.toLowerCase();
    return installedSkills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [installedSkills, searchQuery]);

  const showFeatured = activeTab === "browse" && !browseQuery.trim() && !activeCategory;
  const topFeatured = useMemo(
    () => featuredSkills.slice(0, 6),
    [featuredSkills],
  );

  return (
    <div className={embedded ? "" : "p-6 max-w-5xl mx-auto"}>
      {!embedded && (
        <div className="flex items-end justify-between mb-6">
          <div>
            <h1 className="font-instrument text-3xl tracking-tight mb-1" style={{ color: "var(--color-text)" }}>
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
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className="px-4 py-1.5 rounded-lg text-sm font-medium transition-all cursor-pointer flex items-center gap-1.5"
              style={{
                background: activeTab === tab.id ? "var(--color-surface)" : "transparent",
                color: activeTab === tab.id ? "var(--color-text)" : "var(--color-text-muted)",
                boxShadow: activeTab === tab.id ? "var(--shadow-sm)" : "none",
              }}
            >
              <Icon />
              {tab.label}
            </button>
          );
        })}
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

      {/* Category pills (Browse tab only) */}
      {activeTab === "browse" && categories.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => handleCategoryClick(null)}
            className="rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer"
            style={{
              background: !activeCategory ? "var(--color-accent)" : "var(--color-surface)",
              color: !activeCategory ? "var(--color-bg, #fff)" : "var(--color-text-muted)",
              border: !activeCategory ? "none" : "1px solid var(--color-border)",
            }}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => handleCategoryClick(activeCategory === cat ? null : cat)}
              className="rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer"
              style={{
                background: activeCategory === cat ? "var(--color-accent)" : "var(--color-surface)",
                color: activeCategory === cat ? "var(--color-bg, #fff)" : "var(--color-text-muted)",
                border: activeCategory === cat ? "none" : "1px solid var(--color-border)",
              }}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

      {/* Notices */}
      {(panelNotice || installedRefreshing || installedError) && (
        <div className="mb-4 space-y-2">
          {panelNotice && <StatusNotice tone={panelNotice.tone}>{panelNotice.text}</StatusNotice>}
          {installedRefreshing && <StatusNotice tone="info">Refreshing installed skills...</StatusNotice>}
          {installedError && <StatusNotice tone="error">{installedError}</StatusNotice>}
        </div>
      )}

      {/* Tab content */}
      {activeTab === "installed" && (
        <InstalledTab
          skills={filteredInstalled}
          loading={loading}
          error={installedError}
          removingSlug={removingSlug}
          confirmRemove={confirmRemove}
          onConfirmRemove={setConfirmRemove}
          onRemove={handleRemove}
          onRetry={() => void fetchInstalled({ showSpinner: true })}
          onSkillClick={handleSkillClick}
        />
      )}

      {activeTab === "browse" && (
        <BrowseTab
          skills={browseSkills}
          loading={browseLoading}
          error={browseError}
          installedSlugs={installedSlugs}
          installStatuses={installStatuses}
          onInstall={handleInstall}
          onRetry={() => void fetchBrowse(browseQuery, activeCategory)}
          showFeatured={showFeatured}
          featuredSkills={topFeatured}
          featuredLoading={featuredLoading}
        />
      )}

      {/* Detail drawer */}
      {detailSkill && (
        <SkillDetailDrawer
          skill={detailSkill}
          content={detailContent}
          loading={detailLoading}
          onClose={() => setDetailSkill(null)}
          onRemove={(slug) => {
            setDetailSkill(null);
            setConfirmRemove(null);
            void handleRemove(slug);
          }}
        />
      )}
    </div>
  );
}

/* ---------- Installed tab ---------- */

function InstalledTab({
  skills,
  loading,
  error,
  removingSlug,
  confirmRemove,
  onConfirmRemove,
  onRemove,
  onRetry,
  onSkillClick,
}: {
  skills: InstalledSkillData[];
  loading: boolean;
  error: string | null;
  removingSlug: string | null;
  confirmRemove: string | null;
  onConfirmRemove: (slug: string | null) => void;
  onRemove: (slug: string) => void;
  onRetry: () => void;
  onSkillClick: (skill: InstalledSkillData) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }} />
      </div>
    );
  }

  if (error && skills.length === 0) {
    return (
      <div className="p-8 text-center rounded-2xl" style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
        <p className="text-sm mb-3" style={{ color: "var(--color-text-muted)" }}>Could not load installed skills</p>
        <p className="text-xs mb-4" style={{ color: "var(--color-text-muted)" }}>{error}</p>
        <button type="button" onClick={onRetry} className="text-xs px-3 py-1.5 rounded-lg cursor-pointer" style={{ background: "var(--color-accent)", color: "var(--color-bg)" }}>
          Retry
        </button>
      </div>
    );
  }

  if (skills.length === 0) {
    return (
      <div className="p-8 text-center rounded-2xl" style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
        <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>No installed skills found.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {skills.map((skill) => (
        <InstalledSkillCard
          key={skill.slug}
          skill={skill}
          removingSlug={removingSlug}
          confirmRemove={confirmRemove}
          onConfirmRemove={onConfirmRemove}
          onRemove={onRemove}
          onClick={() => onSkillClick(skill)}
        />
      ))}
    </div>
  );
}

/* ---------- Browse tab ---------- */

function BrowseTab({
  skills,
  loading,
  error,
  installedSlugs,
  installStatuses,
  onInstall,
  onRetry,
  showFeatured,
  featuredSkills,
  featuredLoading,
}: {
  skills: BrowseSkillData[];
  loading: boolean;
  error: string | null;
  installedSlugs: Set<string>;
  installStatuses: Record<string, InstallStatus>;
  onInstall: (skill: BrowseSkillData) => void;
  onRetry: () => void;
  showFeatured: boolean;
  featuredSkills: BrowseSkillData[];
  featuredLoading: boolean;
}) {
  const isInitialLoad = loading && skills.length === 0 && featuredSkills.length === 0;

  if (isInitialLoad) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }} />
      </div>
    );
  }

  if (error && skills.length === 0 && featuredSkills.length === 0) {
    return (
      <div className="p-8 text-center rounded-2xl" style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
        <p className="text-sm mb-3" style={{ color: "var(--color-text-muted)" }}>Could not load skills</p>
        <p className="text-xs mb-4" style={{ color: "var(--color-text-muted)" }}>{error}</p>
        <button type="button" onClick={onRetry} className="text-xs px-3 py-1.5 rounded-lg cursor-pointer" style={{ background: "var(--color-accent)", color: "var(--color-bg)" }}>
          Retry
        </button>
      </div>
    );
  }

  if (!showFeatured && skills.length === 0) {
    return (
      <div className="p-8 text-center rounded-2xl" style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
        <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>No skills found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Featured / Popular section */}
      {showFeatured && featuredSkills.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--color-text-muted)" }}>
            Popular Skills
          </h2>
          {featuredLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-5 h-5 border-2 rounded-full animate-spin" style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }} />
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {featuredSkills.map((skill) => (
                <BrowseSkillCard
                  key={skill.slug}
                  skill={skill}
                  isInstalled={installedSlugs.has(skill.slug)}
                  installStatus={installStatuses[skill.slug]}
                  onInstall={() => onInstall(skill)}
                  featured
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* All / search results */}
      {skills.length > 0 && (
        <div>
          {showFeatured && (
            <h2 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--color-text-muted)" }}>
              All Skills
            </h2>
          )}
          {loading && (
            <div className="text-xs mb-2" style={{ color: "var(--color-text-muted)" }}>
              Loading skills...
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {skills.map((skill) => (
              <BrowseSkillCard
                key={skill.slug}
                skill={skill}
                isInstalled={installedSlugs.has(skill.slug)}
                installStatus={installStatuses[skill.slug]}
                onInstall={() => onInstall(skill)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Detail drawer ---------- */

function SkillDetailDrawer({
  skill,
  content,
  loading,
  onClose,
  onRemove,
}: {
  skill: InstalledSkillData;
  content: string | null;
  loading: boolean;
  onClose: () => void;
  onRemove: (slug: string) => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        style={{ background: "rgba(0,0,0,0.4)" }}
        onClick={onClose}
        role="presentation"
      />
      {/* Drawer */}
      <div
        className="fixed top-0 right-0 bottom-0 z-50 w-full max-w-lg flex flex-col overflow-hidden"
        style={{ background: "var(--color-bg, #0a0a0a)", borderLeft: "1px solid var(--color-border)" }}
        role="dialog"
        aria-label={`${skill.name} details`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 shrink-0" style={{ borderBottom: "1px solid var(--color-border)" }}>
          <div className="flex items-center gap-3 min-w-0">
            {skill.emoji && <span className="text-xl">{skill.emoji}</span>}
            <div className="min-w-0">
              <h2 className="text-base font-semibold truncate" style={{ color: "var(--color-text)" }}>{skill.name}</h2>
              <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>{skill.source}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg cursor-pointer transition-colors"
            style={{ color: "var(--color-text-muted)" }}
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {skill.description && (
            <p className="text-sm mb-4 leading-relaxed" style={{ color: "var(--color-text-muted)" }}>{skill.description}</p>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-5 h-5 border-2 rounded-full animate-spin" style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }} />
            </div>
          ) : content ? (
            <div className="prose prose-sm prose-invert max-w-none">
              <pre
                className="text-xs leading-relaxed whitespace-pre-wrap"
                style={{ color: "var(--color-text)", background: "transparent", border: "none", padding: 0 }}
              >
                {content}
              </pre>
            </div>
          ) : (
            <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>No content available for this skill.</p>
          )}
        </div>

        {/* Footer */}
        {!skill.protected && (
          <div className="px-6 py-4 shrink-0" style={{ borderTop: "1px solid var(--color-border)" }}>
            <button
              type="button"
              onClick={() => onRemove(skill.slug)}
              className="text-sm px-4 py-2 rounded-xl cursor-pointer transition-colors w-full"
              style={{
                background: "color-mix(in srgb, var(--color-error, #ef4444) 12%, transparent)",
                color: "var(--color-error, #ef4444)",
                border: "1px solid color-mix(in srgb, var(--color-error, #ef4444) 28%, transparent)",
              }}
            >
              Remove Skill
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/* ---------- Icons ---------- */

function PackageIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m7.5 4.27 9 5.15" />
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  );
}

function CompassIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </svg>
  );
}
