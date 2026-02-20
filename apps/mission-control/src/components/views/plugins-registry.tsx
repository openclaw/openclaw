"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Package,
  Search,
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Bot,
  Zap,
  Server,
  Clock,
  Link2,
  Code,
  Hash,
  FolderSymlink,
  LayoutGrid,
  List,
  Shield,
  Database,
  Cpu,
  Globe,
  TestTube,
  Gauge,
  Coins,
  Briefcase,
  FileText,
  Plug,
  Wrench,
  ScanSearch,
  AlertTriangle,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";

// --- Types (mirror plugin-scanner.ts) ---

interface PluginSkill {
  name: string;
  path: string;
  description?: string;
}

interface PluginAgent {
  name: string;
  path: string;
}

interface PluginMcpServer {
  name: string;
  type: string;
  url?: string;
  command?: string;
}

interface PluginEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  category: string;
  scope: "official" | "local";
  installPath: string;
  skills: PluginSkill[];
  agents: PluginAgent[];
  commands: string[];
  hooks: string[];
  mcpServers: PluginMcpServer[];
  isSymlinked: boolean;
  installedAt?: string;
}

interface PluginCatalog {
  plugins: PluginEntry[];
  totalSkills: number;
  totalAgents: number;
  totalMcpServers: number;
  categories: string[];
  scannedAt: string;
}

// --- Category icons ---

function renderCategoryIcon(category: string, className?: string) {
  switch (category) {
    case "engineering":
      return <Code className={className} />;
    case "ai-ml":
      return <Cpu className={className} />;
    case "business":
      return <Briefcase className={className} />;
    case "security":
      return <Shield className={className} />;
    case "devops":
      return <Wrench className={className} />;
    case "database":
      return <Database className={className} />;
    case "api":
      return <Globe className={className} />;
    case "testing":
      return <TestTube className={className} />;
    case "performance":
      return <Gauge className={className} />;
    case "crypto":
      return <Coins className={className} />;
    case "productivity":
      return <Zap className={className} />;
    case "saas":
      return <Plug className={className} />;
    case "document":
      return <FileText className={className} />;
    case "integration":
      return <Link2 className={className} />;
    default:
      return <Package className={className} />;
  }
}

// --- Helpers ---

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function groupByCategory(
  plugins: PluginEntry[]
): Record<string, PluginEntry[]> {
  const groups: Record<string, PluginEntry[]> = {};
  for (const p of plugins) {
    if (!groups[p.category]) groups[p.category] = [];
    groups[p.category].push(p);
  }
  return groups;
}

// --- Sub-components ---

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="glass-panel rounded-xl p-4 flex flex-col gap-1.5 min-w-0">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <div className="w-7 h-7 rounded flex items-center justify-center bg-primary/10">
          <Icon className="w-3.5 h-3.5 text-primary" />
        </div>
      </div>
      <div className="text-xl font-bold font-mono">{value}</div>
    </div>
  );
}

function CategoryBadge({ category }: { category: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary px-2 py-1 rounded-md font-medium capitalize">
      {renderCategoryIcon(category, "w-3 h-3")}
      {category}
    </span>
  );
}

function ScopeBadge({ scope }: { scope: "official" | "local" }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md font-medium ${scope === "official"
          ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
          : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
        }`}
    >
      {scope === "official" ? "Official" : "Local"}
    </span>
  );
}

function PluginCountChips({
  skills,
  agents,
  mcpServers,
}: {
  skills: number;
  agents: number;
  mcpServers: number;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {skills > 0 && (
        <span className="inline-flex items-center gap-1 text-xs bg-violet-500/10 text-violet-600 dark:text-violet-400 px-2 py-0.5 rounded font-mono">
          <Zap className="w-3 h-3" />
          {skills} skill{skills !== 1 ? "s" : ""}
        </span>
      )}
      {agents > 0 && (
        <span className="inline-flex items-center gap-1 text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded font-mono">
          <Bot className="w-3 h-3" />
          {agents} agent{agents !== 1 ? "s" : ""}
        </span>
      )}
      {mcpServers > 0 && (
        <span className="inline-flex items-center gap-1 text-xs bg-blue-500/10 text-blue-600 dark:text-blue-400 px-2 py-0.5 rounded font-mono">
          <Server className="w-3 h-3" />
          {mcpServers} MCP
        </span>
      )}
    </div>
  );
}

function ExpandedDetails({ plugin }: { plugin: PluginEntry }) {
  return (
    <div className="space-y-4 pt-3 border-t border-border">
      {/* Skills list */}
      {plugin.skills.length > 0 && (
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
            <Zap className="w-3 h-3" />
            Skills ({plugin.skills.length})
          </h4>
          <div className="space-y-1.5">
            {plugin.skills.map((skill) => (
              <div
                key={skill.name}
                className="flex items-start gap-2 text-sm rounded-lg bg-muted/50 px-3 py-2"
              >
                <div className="w-1.5 h-1.5 rounded-full bg-violet-500 shrink-0 mt-1.5" />
                <div className="min-w-0 flex-1">
                  <span className="font-medium font-mono text-xs">
                    {skill.name}
                  </span>
                  {skill.description && (
                    <p className="text-xs text-muted-foreground/80 line-clamp-2 mt-0.5">
                      {skill.description}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Agents list */}
      {plugin.agents.length > 0 && (
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
            <Bot className="w-3 h-3" />
            Agents ({plugin.agents.length})
          </h4>
          <div className="space-y-1.5">
            {plugin.agents.map((agent) => (
              <div
                key={agent.name}
                className="flex items-center gap-2 text-sm rounded-lg bg-muted/50 px-3 py-2"
              >
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                <span className="font-medium font-mono text-xs">
                  {agent.name}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* MCP Servers */}
      {plugin.mcpServers.length > 0 && (
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
            <Server className="w-3 h-3" />
            MCP Servers ({plugin.mcpServers.length})
          </h4>
          <div className="space-y-1.5">
            {plugin.mcpServers.map((server) => (
              <div
                key={server.name}
                className="flex items-center gap-2 text-sm rounded-lg bg-muted/50 px-3 py-2"
              >
                <div className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
                <span className="font-medium font-mono text-xs">
                  {server.name}
                </span>
                <span className="inline-flex items-center gap-1 text-xs bg-blue-500/10 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded font-mono">
                  {server.type}
                </span>
                {server.url && (
                  <span className="text-xs text-muted-foreground/60 font-mono truncate ml-auto flex items-center gap-1">
                    <Link2 className="w-3 h-3" />
                    {server.url}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Commands */}
      {plugin.commands.length > 0 && (
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
            <Hash className="w-3 h-3" />
            Commands ({plugin.commands.length})
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {plugin.commands.map((cmd) => (
              <span
                key={cmd}
                className="text-xs font-mono bg-muted/50 text-muted-foreground px-2 py-1 rounded"
              >
                {cmd}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Hooks */}
      {plugin.hooks.length > 0 && (
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
            <Code className="w-3 h-3" />
            Hooks ({plugin.hooks.length})
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {plugin.hooks.map((hook) => (
              <span
                key={hook}
                className="text-xs font-mono bg-muted/50 text-muted-foreground px-2 py-1 rounded"
              >
                {hook}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Metadata footer */}
      <div className="flex items-center gap-4 flex-wrap text-xs text-muted-foreground/60 pt-2 border-t border-border">
        <span
          className="font-mono truncate max-w-xs"
          title={plugin.installPath}
        >
          {plugin.installPath}
        </span>
        {plugin.isSymlinked && (
          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <FolderSymlink className="w-3 h-3" />
            Symlinked
          </span>
        )}
        {plugin.installedAt && (
          <span className="inline-flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {formatDate(plugin.installedAt)}
          </span>
        )}
      </div>
    </div>
  );
}

function PluginCard({
  plugin,
  isExpanded,
  onToggleExpand,
  viewMode,
}: {
  plugin: PluginEntry;
  isExpanded: boolean;
  onToggleExpand: () => void;
  viewMode: "grid" | "list";
}) {
  const hasDetails =
    plugin.skills.length > 0 ||
    plugin.agents.length > 0 ||
    plugin.mcpServers.length > 0 ||
    plugin.commands.length > 0 ||
    plugin.hooks.length > 0;

  if (viewMode === "list") {
    return (
      <div className="glass-panel rounded-xl p-5 flex flex-col gap-3">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            {renderCategoryIcon(plugin.category, "w-5 h-5 text-primary")}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-bold text-base truncate">{plugin.name}</h3>
              <span className="text-xs font-mono text-muted-foreground">
                v{plugin.version}
              </span>
            </div>
            <p className="text-sm text-muted-foreground line-clamp-1 mt-0.5">
              {plugin.description}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <PluginCountChips
              skills={plugin.skills.length}
              agents={plugin.agents.length}
              mcpServers={plugin.mcpServers.length}
            />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <CategoryBadge category={plugin.category} />
            <ScopeBadge scope={plugin.scope} />
          </div>
          {hasDetails && (
            <button
              onClick={onToggleExpand}
              className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center hover:bg-muted transition-colors"
            >
              {isExpanded ? (
                <ChevronUp className="w-4 h-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              )}
            </button>
          )}
        </div>
        {isExpanded && <ExpandedDetails plugin={plugin} />}
      </div>
    );
  }

  // Grid mode card
  return (
    <div className="glass-panel rounded-xl p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            {renderCategoryIcon(plugin.category, "w-4 h-4 text-primary")}
          </div>
          <div className="min-w-0">
            <h3 className="font-bold text-base truncate">{plugin.name}</h3>
            {plugin.author && (
              <p className="text-xs text-muted-foreground truncate">
                by {plugin.author}
              </p>
            )}
          </div>
        </div>
        <span className="text-xs font-mono text-muted-foreground shrink-0">
          v{plugin.version}
        </span>
      </div>

      <p className="text-sm text-muted-foreground line-clamp-2">
        {plugin.description}
      </p>

      <div className="flex items-center gap-2 flex-wrap">
        <CategoryBadge category={plugin.category} />
        <ScopeBadge scope={plugin.scope} />
        {plugin.isSymlinked && (
          <span className="inline-flex items-center gap-1 text-xs bg-amber-500/10 text-amber-600 dark:text-amber-400 px-2 py-1 rounded-md font-medium">
            <FolderSymlink className="w-3 h-3" />
            Symlinked
          </span>
        )}
      </div>

      <PluginCountChips
        skills={plugin.skills.length}
        agents={plugin.agents.length}
        mcpServers={plugin.mcpServers.length}
      />

      {hasDetails && (
        <button
          onClick={onToggleExpand}
          className="flex items-center gap-1.5 text-xs text-primary hover:underline mt-1 self-start"
        >
          {isExpanded ? (
            <>
              <ChevronUp className="w-3.5 h-3.5" />
              Hide details
            </>
          ) : (
            <>
              <ChevronDown className="w-3.5 h-3.5" />
              Show details
            </>
          )}
        </button>
      )}

      {isExpanded && <ExpandedDetails plugin={plugin} />}
    </div>
  );
}

function CategorySectionHeader({
  category,
  count,
}: {
  category: string;
  count: number;
}) {
  return (
    <div className="flex items-center gap-2.5 mb-4 mt-8 first:mt-0">
      <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
        {renderCategoryIcon(category, "w-4 h-4 text-primary")}
      </div>
      <h3 className="font-bold text-lg capitalize">{category}</h3>
      <span className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
        {count}
      </span>
      <div className="flex-1 h-px bg-border ml-2" />
    </div>
  );
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div className="glass-panel rounded-xl p-12 flex flex-col items-center justify-center text-center gap-4">
      <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
        {hasFilters ? (
          <Search className="w-8 h-8 text-muted-foreground" />
        ) : (
          <Package className="w-8 h-8 text-muted-foreground" />
        )}
      </div>
      <div>
        <h3 className="font-bold text-lg mb-2">
          {hasFilters ? "No matching plugins" : "No plugins detected"}
        </h3>
        <p className="text-sm text-muted-foreground max-w-md">
          {hasFilters
            ? "Try adjusting your search query or filters to see more plugins."
            : "Make sure Claude Code plugins are installed at ~/.claude/plugins/."}
        </p>
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="glass-panel rounded-xl p-5 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="skeleton skeleton-text w-20 h-3" />
              <div className="skeleton w-8 h-8 rounded" />
            </div>
            <div className="skeleton skeleton-title w-12 h-7" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="glass-panel rounded-xl p-5 flex flex-col gap-3">
            <div className="flex items-center gap-2.5">
              <div className="skeleton w-9 h-9 rounded-lg" />
              <div className="flex-1 space-y-1.5">
                <div className="skeleton skeleton-text w-32 h-4" />
                <div className="skeleton skeleton-text w-20 h-3" />
              </div>
            </div>
            <div className="skeleton skeleton-text w-full h-3" />
            <div className="skeleton skeleton-text w-3/4 h-3" />
            <div className="flex gap-2">
              <div className="skeleton w-16 h-6 rounded-md" />
              <div className="skeleton w-16 h-6 rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Filter components ---

function CategoryFilterBar({
  categories,
  selected,
  onSelect,
}: {
  categories: string[];
  selected: string;
  onSelect: (cat: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <button
        onClick={() => onSelect("all")}
        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${selected === "all"
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
          }`}
      >
        All
      </button>
      {categories.map((cat) => {
        return (
          <button
            key={cat}
            onClick={() => onSelect(cat)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all capitalize ${selected === cat
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
              }`}
          >
            {renderCategoryIcon(cat, "w-3 h-3")}
            {cat}
          </button>
        );
      })}
    </div>
  );
}

function ScopeFilterBar({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (scope: string) => void;
}) {
  const scopes = [
    { key: "all", label: "All" },
    { key: "official", label: "Official" },
    { key: "local", label: "Local" },
  ];

  return (
    <div className="flex items-center gap-1">
      {scopes.map((scope) => (
        <button
          key={scope.key}
          onClick={() => onSelect(scope.key)}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${selected === scope.key
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
            }`}
        >
          {scope.label}
        </button>
      ))}
    </div>
  );
}

function ViewModeToggle({
  mode,
  onToggle,
}: {
  mode: "grid" | "list";
  onToggle: (mode: "grid" | "list") => void;
}) {
  return (
    <div className="flex items-center bg-muted rounded-lg p-0.5">
      <button
        onClick={() => onToggle("grid")}
        className={`p-1.5 rounded-md transition-all ${mode === "grid"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
          }`}
        title="Grid view"
      >
        <LayoutGrid className="w-4 h-4" />
      </button>
      <button
        onClick={() => onToggle("list")}
        className={`p-1.5 rounded-md transition-all ${mode === "list"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
          }`}
        title="List view"
      >
        <List className="w-4 h-4" />
      </button>
    </div>
  );
}

// --- Main Component ---

export function PluginsRegistry() {
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [rescanning, setRescanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [expandedPlugins, setExpandedPlugins] = useState<Set<string>>(
    new Set()
  );

  const fetchPlugins = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/plugins");
      if (!res.ok) throw new Error(`Failed to fetch plugins (${res.status})`);
      const json = (await res.json()) as PluginCatalog;
      setCatalog(json);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load plugins";
      setError(message);
      setCatalog(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const rescanPlugins = useCallback(async () => {
    setRescanning(true);
    try {
      const res = await fetch("/api/plugins", { method: "POST" });
      if (!res.ok) throw new Error(`Rescan failed (${res.status})`);
      const json = (await res.json()) as PluginCatalog;
      setCatalog(json);
    } catch {
      await fetchPlugins();
    } finally {
      setRescanning(false);
    }
  }, [fetchPlugins]);

  useEffect(() => {
    fetchPlugins();
    const interval = setInterval(fetchPlugins, 60_000);
    return () => clearInterval(interval);
  }, [fetchPlugins]);

  const filteredPlugins = useMemo(() => {
    if (!catalog) return [];
    return catalog.plugins.filter((plugin) => {
      if (search) {
        const q = search.toLowerCase();
        const matches =
          plugin.name.toLowerCase().includes(q) ||
          plugin.description.toLowerCase().includes(q) ||
          (plugin.author?.toLowerCase().includes(q) ?? false);
        if (!matches) return false;
      }
      if (categoryFilter !== "all" && plugin.category !== categoryFilter)
        return false;
      if (scopeFilter !== "all" && plugin.scope !== scopeFilter) return false;
      return true;
    });
  }, [catalog, search, categoryFilter, scopeFilter]);

  const groupedPlugins = useMemo(
    () => groupByCategory(filteredPlugins),
    [filteredPlugins]
  );

  const hasActiveFilters =
    search !== "" || categoryFilter !== "all" || scopeFilter !== "all";

  const toggleExpand = useCallback((pluginId: string) => {
    setExpandedPlugins((prev) => {
      const next = new Set(prev);
      if (next.has(pluginId)) next.delete(pluginId);
      else next.add(pluginId);
      return next;
    });
  }, []);

  return (
    <div className="flex-1 overflow-auto p-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Package className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Plugin Registry</h2>
            <p className="text-sm text-muted-foreground max-w-2xl">
              Browse all installed plugins with their skills, agents, MCP
              servers, and hooks.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={rescanPlugins}
            disabled={rescanning || loading}
            className="gap-1.5"
          >
            {rescanning ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ScanSearch className="w-3.5 h-3.5" />
            )}
            Rescan
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchPlugins}
            disabled={loading}
            className="gap-1.5"
          >
            {loading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Refresh
          </Button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="glass-panel rounded-xl p-4 mb-6 border-l-4 border-amber-500 bg-amber-500/5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div>
              <h3 className="font-bold text-sm text-amber-900 dark:text-amber-100 mb-1">
                Connection Error
              </h3>
              <p className="text-sm text-amber-700 dark:text-amber-300">
                {error}
              </p>
            </div>
          </div>
        </div>
      )}

      {loading && !catalog ? (
        <LoadingSkeleton />
      ) : (
        <>
          {/* Stats ribbon */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <StatCard
              label="Total Plugins"
              value={catalog?.plugins.length ?? 0}
              icon={Package}
            />
            <StatCard
              label="Total Skills"
              value={catalog?.totalSkills ?? 0}
              icon={Zap}
            />
            <StatCard
              label="Total Agents"
              value={catalog?.totalAgents ?? 0}
              icon={Bot}
            />
            <StatCard
              label="MCP Servers"
              value={catalog?.totalMcpServers ?? 0}
              icon={Server}
            />
          </div>

          {/* Scanned at */}
          {catalog?.scannedAt && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4">
              <Clock className="w-3 h-3" />
              Last scanned: {formatDate(catalog.scannedAt)}
            </div>
          )}

          {/* Search + filters */}
          <div className="space-y-3 mb-6">
            <div className="flex items-center gap-3">
              <div className="relative flex-1 flex items-center">
                <Search className="absolute left-3.5 w-4 h-4 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search plugins by name, description, or author..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-10 pr-10 py-2.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-ring/50 focus:border-ring transition-all"
                />
                {search && (
                  <button
                    onClick={() => setSearch("")}
                    className="absolute right-3.5 p-1 rounded-full text-muted-foreground hover:bg-muted focus:outline-none transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <ViewModeToggle mode={viewMode} onToggle={setViewMode} />
            </div>

            <div className="flex items-center justify-between gap-4 flex-wrap">
              {catalog?.categories && catalog.categories.length > 0 && (
                <CategoryFilterBar
                  categories={catalog.categories}
                  selected={categoryFilter}
                  onSelect={setCategoryFilter}
                />
              )}
              <ScopeFilterBar
                selected={scopeFilter}
                onSelect={setScopeFilter}
              />
            </div>
          </div>

          {/* Active filter summary */}
          {hasActiveFilters && (
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xs text-muted-foreground">
                Showing {filteredPlugins.length} of{" "}
                {catalog?.plugins.length ?? 0} plugins
              </span>
              <button
                onClick={() => {
                  setSearch("");
                  setCategoryFilter("all");
                  setScopeFilter("all");
                }}
                className="text-xs text-primary hover:underline"
              >
                Clear filters
              </button>
            </div>
          )}

          {/* Plugin cards */}
          {filteredPlugins.length > 0 ? (
            <div className="space-y-0">
              {Object.entries(groupedPlugins).map(([category, plugins]) => (
                <div key={category}>
                  <CategorySectionHeader
                    category={category}
                    count={plugins.length}
                  />
                  <div
                    className={
                      viewMode === "grid"
                        ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6"
                        : "flex flex-col gap-3 mb-6"
                    }
                  >
                    {plugins.map((plugin) => (
                      <PluginCard
                        key={plugin.id}
                        plugin={plugin}
                        isExpanded={expandedPlugins.has(plugin.id)}
                        onToggleExpand={() => toggleExpand(plugin.id)}
                        viewMode={viewMode}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState hasFilters={hasActiveFilters} />
          )}
        </>
      )}
    </div>
  );
}
