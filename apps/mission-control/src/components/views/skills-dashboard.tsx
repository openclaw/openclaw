"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Zap,
  RefreshCw,
  Loader2,
  Search,
  Puzzle,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Box,
  Tag,
  Globe,
  Package,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DASHBOARD_RECOMMENDED_SKILLS,
  type RecommendedSkill,
} from "@/lib/recommended-skills";

// --- Types ---

interface Skill {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  eligible: boolean;
  source?: string;
  emoji?: string;
  homepage?: string;
  missingDeps?: string[];
  category?: string;
  origin: "gateway" | "plugin" | "community";
}

interface SkillsResponse {
  skills: unknown;
  degraded?: boolean;
  warning?: string;
}

interface PluginCatalog {
  plugins: {
    id: string;
    name: string;
    category: string;
    skills: { name: string; path: string; description?: string }[];
  }[];
  totalSkills: number;
  categories: string[];
}

interface CommunitySkillsResponse {
  skills: Array<{
    id?: string;
    slug?: string;
    name?: string;
    description?: string;
    category?: string;
    source?: string;
    scriptsCount?: number;
    referencesCount?: number;
  }>;
  total?: number;
  generatedAt?: string;
  sourceZips?: string[];
}

type SourceFilter = "all" | "gateway" | "plugins" | "community";

// --- Helpers ---

function parseGatewaySkills(data: SkillsResponse): Skill[] {
  const { skills } = data;
  if (!skills) return [];
  if (!Array.isArray(skills)) return [];

  return skills
    .filter((item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null
    )
    .map((item) => ({
      id: String(item.skillKey || item.name || Math.random()),
      name: String(item.name || "Unknown Skill"),
      description: item.description ? String(item.description) : undefined,
      enabled: !item.disabled,
      eligible: item.eligible !== false,
      source: item.source ? String(item.source) : "gateway",
      emoji: item.emoji ? String(item.emoji) : undefined,
      homepage: item.homepage ? String(item.homepage) : undefined,
      missingDeps: Array.isArray((item.missing as Record<string, unknown>)?.bins)
        ? ((item.missing as Record<string, unknown>).bins as string[])
        : undefined,
      origin: "gateway" as const,
    }));
}

function parsePluginSkills(catalog: PluginCatalog): Skill[] {
  const skills: Skill[] = [];
  for (const plugin of catalog.plugins) {
    for (const skill of plugin.skills) {
      skills.push({
        id: `plugin:${plugin.id}:${skill.name}`,
        name: skill.name,
        description: skill.description,
        enabled: true,
        eligible: true,
        source: `plugin:${plugin.name}`,
        category: plugin.category,
        origin: "plugin",
      });
    }
  }
  return skills;
}

function parseCommunitySkills(catalog: CommunitySkillsResponse | null): Skill[] {
  if (!catalog || !Array.isArray(catalog.skills)) return [];
  return catalog.skills
    .filter((skill) => skill && typeof skill === "object")
    .map((skill) => {
      const normalizedName = String(skill.name || skill.slug || "Community Skill");
      const slug = String(skill.slug || normalizedName).toLowerCase();
      return {
        id: String(skill.id || `community:${slug}`),
        name: normalizedName,
        description: skill.description ? String(skill.description) : undefined,
        enabled: true,
        eligible: true,
        source: `community:${String(skill.source || "library")}`,
        category: skill.category ? String(skill.category) : "community",
        origin: "community" as const,
      };
    });
}

function getCategoryCounts(skills: Skill[]): Map<string, number> {
  const counts = new Map<string, number>();
  skills.forEach((skill) => {
    const cat = skill.category || "uncategorized";
    counts.set(cat, (counts.get(cat) || 0) + 1);
  });
  return counts;
}

function normalizeSkillToken(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const CATEGORY_LABELS: Record<string, string> = {
  engineering: "Engineering",
  "ai-ml": "AI & ML",
  business: "Business",
  security: "Security",
  devops: "DevOps",
  database: "Database",
  api: "API",
  testing: "Testing",
  performance: "Performance",
  crypto: "Crypto & DeFi",
  productivity: "Productivity",
  saas: "SaaS",
  document: "Documents",
  custom: "Custom",
  integration: "Integration",
  workflow: "Workflow",
  "developer-tools": "Developer Tools",
  uncategorized: "Other",
  community: "Community",
};

// --- Sub-components ---

function StatCard({
  label,
  value,
  icon: Icon,
  href,
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  href?: string;
}) {
  const content = (
    <div className="glass-panel rounded-xl p-5 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <div className="w-8 h-8 rounded flex items-center justify-center bg-primary/10">
          <Icon className="w-4 h-4 text-primary" />
        </div>
      </div>
      <div className="text-2xl font-bold font-mono">{value}</div>
    </div>
  );

  if (href) {
    return (
      <button
        onClick={() => {
          const el = document.querySelector(href);
          el?.scrollIntoView({ behavior: "smooth" });
        }}
        className="text-left hover:scale-[1.02] transition-transform"
      >
        {content}
      </button>
    );
  }

  return content;
}

function SkillCard({ skill }: { skill: Skill }) {
  const isReady = skill.enabled && skill.eligible;
  const isPlugin = skill.origin === "plugin";

  return (
    <div className="glass-panel rounded-xl p-5 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          {skill.emoji ? (
            <span className="text-xl shrink-0">{skill.emoji}</span>
          ) : isPlugin ? (
            <Box className="w-5 h-5 text-violet-500 shrink-0" />
          ) : null}
          <h3 className="font-bold text-base truncate">{skill.name}</h3>
        </div>

        {/* Status indicator */}
        <div className="shrink-0">
          {isReady ? (
            <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="font-medium">Ready</span>
            </div>
          ) : !skill.eligible ? (
            <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <div className="w-2 h-2 rounded-full bg-amber-500" />
              <span className="font-medium">Missing Deps</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <div className="w-2 h-2 rounded-full bg-muted-foreground" />
              <span className="font-medium">Disabled</span>
            </div>
          )}
        </div>
      </div>

      {/* Description */}
      {skill.description && (
        <p className="text-sm text-muted-foreground line-clamp-2">
          {skill.description}
        </p>
      )}

      {/* Missing deps */}
      {skill.missingDeps && skill.missingDeps.length > 0 && (
        <p className="text-xs text-amber-500">
          Missing: {skill.missingDeps.join(", ")}
        </p>
      )}

      {/* Badges */}
      <div className="flex items-center gap-2 flex-wrap">
        {skill.source && (
          <span className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md font-medium ${
            isPlugin
              ? "bg-violet-500/10 text-violet-500"
              : "bg-primary/10 text-primary"
          }`}>
            {isPlugin
              ? skill.source.replace("plugin:", "")
              : skill.source.replace("openclaw-", "")}
          </span>
        )}
        {skill.category && (
          <span className="inline-flex items-center gap-1 text-xs bg-muted text-muted-foreground px-2 py-1 rounded-md font-medium">
            <Tag className="w-3 h-3" />
            {CATEGORY_LABELS[skill.category] || skill.category}
          </span>
        )}
        {skill.homepage && (
          <a
            href={skill.homepage}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:underline"
          >
            docs
          </a>
        )}
      </div>
    </div>
  );
}

function RecommendedSkillCard({ skill }: { skill: RecommendedSkill }) {
  return (
    <div className="glass-panel rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold text-sm truncate">{skill.name}</h3>
          <p className="text-xs text-muted-foreground">{skill.category}</p>
        </div>
        <a
          href={skill.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary hover:underline inline-flex items-center gap-1 shrink-0"
          title="Open source skill reference"
        >
          source
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      <p className="text-sm text-muted-foreground line-clamp-2">{skill.description}</p>
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Why:</span> {skill.reason}
      </p>

      <div className="mt-auto">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
          Install command
        </p>
        <code className="block w-full overflow-x-auto rounded-md border border-border/70 bg-background px-2 py-1.5 text-xs font-mono">
          npx clawhub@latest install {skill.slug}
        </code>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="glass-panel rounded-xl p-12 flex flex-col items-center justify-center text-center gap-4">
      <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
        <Puzzle className="w-8 h-8 text-muted-foreground" />
      </div>
      <div>
        <h3 className="font-bold text-lg mb-2">No skills detected</h3>
        <p className="text-sm text-muted-foreground max-w-md">
          Make sure the OpenClaw gateway is running and has plugins installed.
        </p>
      </div>
    </div>
  );
}

function SetupInfoPanel() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="glass-panel rounded-xl p-5 mt-6">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between w-full text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">💡</span>
          <span className="font-bold text-sm">What are skills?</span>
        </div>
        {isOpen ? (
          <ChevronUp className="w-4 h-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        )}
      </button>

      {isOpen && (
        <div className="mt-4 space-y-3 text-sm text-muted-foreground border-t border-border pt-4">
          <p>
            Skills are plugins that extend your agents&apos; capabilities. They&apos;re managed by
            the OpenClaw gateway and local Claude Code plugins.
          </p>
          <p>
            <strong className="text-foreground">Gateway skills</strong> come from the OpenClaw runtime —
            web browsing, file access, code execution, and more.
          </p>
          <p>
            <strong className="text-foreground">Plugin skills</strong> come from your installed Claude Code
            plugins — business, engineering, AI/ML, security, and 400+ more.
          </p>
          <p>
            <strong className="text-foreground">Community skills</strong> are curated from imported OpenClaw
            archives in <code>src/community-catalog</code>.
          </p>
        </div>
      )}
    </div>
  );
}

// --- Main Component ---

export function SkillsDashboard() {
  const [gatewayData, setGatewayData] = useState<SkillsResponse | null>(null);
  const [pluginCatalog, setPluginCatalog] = useState<PluginCatalog | null>(null);
  const [communityCatalog, setCommunityCatalog] = useState<CommunitySkillsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [gatewayRes, pluginRes, communityRes] = await Promise.allSettled([
        fetch("/api/openclaw/skills").then((r) => r.json() as Promise<SkillsResponse>),
        fetch("/api/plugins").then((r) => r.json() as Promise<PluginCatalog>),
        fetch("/api/openclaw/community-skills").then(
          (r) => r.json() as Promise<CommunitySkillsResponse>
        ),
      ]);

      if (gatewayRes.status === "fulfilled") {
        setGatewayData(gatewayRes.value);
      } else {
        setGatewayData({ skills: [], degraded: true, warning: "Failed to connect to gateway" });
      }

      if (pluginRes.status === "fulfilled") {
        setPluginCatalog(pluginRes.value);
      }

      if (communityRes.status === "fulfilled") {
        setCommunityCatalog(communityRes.value);
      } else {
        setCommunityCatalog({ skills: [] });
      }
    } catch {
      setGatewayData({ skills: [], degraded: true, warning: "Failed to fetch skills" });
      setCommunityCatalog({ skills: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const intervalId = setInterval(fetchAll, 60_000);
    return () => clearInterval(intervalId);
  }, [fetchAll]);

  // Parse and merge skills
  const gatewaySkills = useMemo(
    () => (gatewayData ? parseGatewaySkills(gatewayData) : []),
    [gatewayData]
  );
  const pluginSkills = useMemo(
    () => (pluginCatalog ? parsePluginSkills(pluginCatalog) : []),
    [pluginCatalog]
  );
  const communitySkills = useMemo(
    () => parseCommunitySkills(communityCatalog),
    [communityCatalog]
  );
  const allSkills = useMemo(
    () => [...gatewaySkills, ...pluginSkills, ...communitySkills],
    [gatewaySkills, pluginSkills, communitySkills]
  );
  const installedSkillKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const skill of allSkills) {
      keys.add(normalizeSkillToken(skill.name));
      if (skill.source) {
        keys.add(normalizeSkillToken(skill.source));
      }
    }
    return keys;
  }, [allSkills]);
  const missingRecommendedSkills = useMemo(
    () =>
      DASHBOARD_RECOMMENDED_SKILLS.filter((skill) => {
        const slugKey = normalizeSkillToken(skill.slug);
        const nameKey = normalizeSkillToken(skill.name);
        return !installedSkillKeys.has(slugKey) && !installedSkillKeys.has(nameKey);
      }),
    [installedSkillKeys]
  );

  const categorySkillPool = useMemo(() => {
    if (sourceFilter === "plugins") return pluginSkills;
    if (sourceFilter === "community") return communitySkills;
    if (sourceFilter === "gateway") return [];
    return [...pluginSkills, ...communitySkills];
  }, [sourceFilter, pluginSkills, communitySkills]);

  const categoryCounts = useMemo(
    () => getCategoryCounts(categorySkillPool),
    [categorySkillPool]
  );
  const categories = useMemo(
    () => Array.from(categoryCounts.keys()).sort(),
    [categoryCounts]
  );

  // Multi-layer filtering
  const filteredSkills = useMemo(() => {
    let skills = allSkills;

    // Source filter
    if (sourceFilter === "gateway") {
      skills = skills.filter((s) => s.origin === "gateway");
    } else if (sourceFilter === "plugins") {
      skills = skills.filter((s) => s.origin === "plugin");
    } else if (sourceFilter === "community") {
      skills = skills.filter((s) => s.origin === "community");
    }

    // Category filter
    if (categoryFilter !== "all") {
      skills = skills.filter((s) => s.category === categoryFilter);
    }

    // Search
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      skills = skills.filter(
        (s) =>
          s.name.toLowerCase().includes(query) ||
          (s.description?.toLowerCase().includes(query) ?? false) ||
          (s.source?.toLowerCase().includes(query) ?? false) ||
          (s.category?.toLowerCase().includes(query) ?? false)
      );
    }

    return skills;
  }, [allSkills, sourceFilter, categoryFilter, searchQuery]);

  const hasAnyFilter = sourceFilter !== "all" || categoryFilter !== "all" || searchQuery.length > 0;

  return (
    <div className="flex-1 overflow-auto p-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Zap className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Skills Dashboard</h2>
            <p className="text-sm text-muted-foreground max-w-2xl">
              Unified view of all agent capabilities — gateway, plugin, and community skills.
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={fetchAll}
          disabled={loading}
          className="gap-1.5 shrink-0"
        >
          {loading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          Refresh
        </Button>
      </div>

      {/* Degraded state banner */}
      {gatewayData?.degraded && (
        <div className="glass-panel rounded-xl p-4 mb-6 border-l-4 border-amber-500 bg-amber-500/5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div>
              <h3 className="font-bold text-sm text-amber-900 dark:text-amber-100 mb-1">
                Gateway Connection Degraded
              </h3>
              <p className="text-sm text-amber-700 dark:text-amber-300">
                {gatewayData.warning || "Unable to fetch skills from the OpenClaw gateway."}
                {(pluginSkills.length > 0 || communitySkills.length > 0) &&
                  " Plugin and community skills are still available below."}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Stats ribbon */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <StatCard label="Total Skills" value={allSkills.length} icon={Puzzle} />
        <StatCard
          label="Gateway"
          value={gatewaySkills.length}
          icon={Globe}
        />
        <StatCard
          label="Plugin Skills"
          value={pluginSkills.length}
          icon={Package}
        />
        <StatCard
          label="Community"
          value={communitySkills.length}
          icon={Box}
        />
        <StatCard
          label="Categories"
          value={categories.length}
          icon={Tag}
        />
      </div>

      {/* Recommended from awesome-openclaw-skills (missing only) */}
      {missingRecommendedSkills.length > 0 && (
        <div className="glass-panel rounded-xl p-5 mb-6">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <h3 className="font-bold text-base">Recommended Skills Not Yet Installed</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Extracted from your forked index at
                {" "}
                <code>/Users/tg/Projects/OpenClaw/awesome-openclaw-skills/README.md</code>.
              </p>
            </div>
            <div className="text-xs font-mono text-muted-foreground bg-muted px-3 py-1.5 rounded border border-border">
              missing {missingRecommendedSkills.length}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {missingRecommendedSkills.slice(0, 12).map((skill) => (
              <RecommendedSkillCard key={skill.slug} skill={skill} />
            ))}
          </div>

          {missingRecommendedSkills.length > 12 && (
            <p className="text-xs text-muted-foreground mt-3">
              Showing top 12 recommendations. Extend
              {" "}
              <code>DASHBOARD_RECOMMENDED_SKILLS</code>
              {" "}
              filtering if you want the full list visible.
            </p>
          )}
        </div>
      )}

      {/* Source filter tabs */}
      <div className="flex items-center gap-2 mb-4">
        {(
          [
            { key: "all", label: "All", count: allSkills.length },
            { key: "gateway", label: "Gateway", count: gatewaySkills.length },
            { key: "plugins", label: "Plugins", count: pluginSkills.length },
            { key: "community", label: "Community", count: communitySkills.length },
          ] as const
        ).map(({ key, label, count }) => (
          <button
            key={key}
            onClick={() => {
              setSourceFilter(key);
              if (key === "gateway") setCategoryFilter("all");
            }}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              sourceFilter === key
                ? "bg-primary/10 text-primary border border-primary/30"
                : "border border-border hover:border-primary/50 text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
            <span className="ml-1.5 text-xs opacity-70">{count}</span>
          </button>
        ))}
      </div>

      {/* Category badges */}
      {sourceFilter !== "gateway" && categories.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap mb-4">
          <button
            onClick={() => setCategoryFilter("all")}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
              categoryFilter === "all"
                ? "bg-primary/10 text-primary border border-primary/30"
                : "border border-border/60 text-muted-foreground hover:text-foreground hover:border-primary/40"
            }`}
          >
            All Categories
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat === categoryFilter ? "all" : cat)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                categoryFilter === cat
                  ? "bg-primary/10 text-primary border border-primary/30"
                  : "border border-border/60 text-muted-foreground hover:text-foreground hover:border-primary/40"
              }`}
            >
              {CATEGORY_LABELS[cat] || cat}
              <span className="ml-1 opacity-70">{categoryCounts.get(cat)}</span>
            </button>
          ))}
        </div>
      )}

      {/* Search bar */}
      <div className="relative mb-6">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          placeholder="Filter skills by name, description, category, or source..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-ring/50 focus:border-ring transition-all"
        />
      </div>

      {/* Skills grid */}
      {filteredSkills.length > 0 ? (
        <div
          id="skills-grid"
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6"
        >
          {filteredSkills.map((skill) => (
            <SkillCard key={skill.id} skill={skill} />
          ))}
        </div>
      ) : hasAnyFilter ? (
        <div className="glass-panel rounded-xl p-12 flex flex-col items-center justify-center text-center gap-4">
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
            <Search className="w-8 h-8 text-muted-foreground" />
          </div>
          <div>
            <h3 className="font-bold text-lg mb-2">No matching skills</h3>
            <p className="text-sm text-muted-foreground max-w-md">
              Try adjusting your filters or search query.
            </p>
            <button
              onClick={() => {
                setSearchQuery("");
                setSourceFilter("all");
                setCategoryFilter("all");
              }}
              className="mt-3 text-sm text-primary hover:underline"
            >
              Clear all filters
            </button>
          </div>
        </div>
      ) : (
        <EmptyState />
      )}

      {/* Setup info panel */}
      <SetupInfoPanel />
    </div>
  );
}
