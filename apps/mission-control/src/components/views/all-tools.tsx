"use client";

import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import {
  LayoutDashboard,
  MessageSquare,
  Zap,
  Bot,
  Brain,
  BookOpen,
  Settings,
  Rocket,
  Link2,
  Radio,
  Puzzle,
  Wrench,
  DollarSign,
  FileText,
  Shield,
  Clock,
  Package,
  Key,
  Server,
  Plug,
  Users,
  Cpu,
  Activity,
  Loader2,
  Search,
  AlertTriangle,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import type { ViewId } from "@/components/layout/sidebar";

// --- Types ---

type ToolLink = {
  id: ViewId;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string | number;
};

type ToolSection = {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string; // Tailwind gradient classes for the section accent
  items: ToolLink[];
};

// --- Gateway Health ---

type GatewayState = "checking" | "connected" | "offline";

function useGatewayHealth() {
  const [state, setState] = useState<GatewayState>("checking");
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const probe = async () => {
      try {
        const res = await fetch("/api/openclaw/tools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool: "health", args: {} }),
        });
        const ct = res.headers.get("content-type") || "";
        const raw = await res.text();
        const data = ct.includes("application/json") ? JSON.parse(raw) : null;

        if (cancelled) return;
        const ok = Boolean(res.ok && data && data.ok === true);
        setState(ok ? "connected" : "offline");
        setHint(
          ok
            ? null
            : data?.error
              ? String(data.error)
              : `Health probe failed (HTTP ${res.status})`
        );
      } catch (e) {
        if (cancelled) return;
        setState("offline");
        setHint(String(e));
      }
    };

    void probe();
    const id = window.setInterval(probe, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return { state, hint };
}

// --- Ecosystem Stats ---

interface EcoStats {
  totalSkills: number;
  totalPlugins: number;
  mcpServers: number;
  aiSpecialists: number;
  loading: boolean;
  failed: boolean;
}

function useEcosystemStats(): EcoStats {
  const [stats, setStats] = useState<EcoStats>({
    totalSkills: 0,
    totalPlugins: 0,
    mcpServers: 0,
    aiSpecialists: 0,
    loading: true,
    failed: false,
  });

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/openclaw/skills");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { skills?: unknown[]; degraded?: boolean };

      if (json.degraded) {
        setStats((prev) => ({ ...prev, loading: false, failed: true }));
        return;
      }

      const skills = Array.isArray(json.skills) ? json.skills : [];

      // Count unique sources as "plugins"
      const sources = new Set<string>();
      let mcpCount = 0;
      for (const s of skills) {
        if (typeof s === "object" && s !== null) {
          const skill = s as Record<string, unknown>;
          if (skill.source) sources.add(String(skill.source));
          const src = String(skill.source || "").toLowerCase();
          if (src.includes("mcp")) mcpCount++;
        }
      }

      setStats({
        totalSkills: skills.length,
        totalPlugins: sources.size || skills.length,
        mcpServers: mcpCount || sources.size,
        aiSpecialists: 0, // No longer hardcoded — will show "—" when 0
        loading: false,
        failed: false,
      });
    } catch {
      setStats((prev) => ({ ...prev, loading: false, failed: true }));
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return stats;
}

// --- Animated Counter ---

function AnimatedNumber({ value, loading, failed }: { value: number; loading?: boolean; failed?: boolean }) {
  if (loading) {
    return <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />;
  }
  if (failed) {
    return <span className="text-muted-foreground/50">—</span>;
  }
  return <span>{value}</span>;
}

// --- Stat Card ---

function StatCard({
  label,
  value,
  icon: Icon,
  loading,
  failed,
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  loading?: boolean;
  failed?: boolean;
}) {
  return (
    <div
      className={`glass-panel rounded-xl p-4 flex flex-col gap-2 min-w-0 transition-all duration-300 ${failed ? "opacity-60" : ""
        }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-primary/10">
          <Icon className="w-4 h-4 text-primary" />
        </div>
      </div>
      <div className="text-2xl font-bold font-mono h-8 flex items-center">
        <AnimatedNumber value={Number(value)} loading={loading} failed={failed} />
      </div>
    </div>
  );
}

// --- Gateway Banner ---

function GatewayBanner({ state, hint }: { state: GatewayState; hint: string | null }) {
  if (state === "checking") {
    return (
      <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-muted/50 border border-border text-sm text-muted-foreground animate-pulse">
        <Loader2 className="w-4 h-4 animate-spin" />
        Checking gateway connection…
      </div>
    );
  }

  if (state === "connected") {
    return (
      <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-success/5 border border-success/20 text-sm">
        <div className="relative flex items-center justify-center">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          <span className="absolute w-2 h-2 rounded-full bg-green-500 ping-slow" />
        </div>
        <Wifi className="w-4 h-4 text-green-500" />
        <span className="text-green-600 dark:text-green-400 font-medium">Gateway connected</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-destructive/5 border border-destructive/20 text-sm">
      <WifiOff className="w-4 h-4 text-destructive shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-destructive">Gateway offline</div>
        <div className="text-xs text-muted-foreground mt-0.5 truncate">
          {hint || "OpenClaw Gateway is not reachable. Start the gateway to enable all tools."}
        </div>
      </div>
      <AlertTriangle className="w-4 h-4 text-destructive/50 shrink-0" />
    </div>
  );
}

// --- Section Data ---

function buildSections(stats: EcoStats): ToolSection[] {
  return [
    {
      label: "Command & Control",
      icon: Zap,
      accent: "from-blue-500/20 to-indigo-500/20",
      items: [
        {
          id: "board",
          label: "Dashboard",
          description: "Kanban board + command center overview.",
          icon: LayoutDashboard,
        },
        {
          id: "chat",
          label: "Chat",
          description: "Direct gateway chat (own scroll context).",
          icon: MessageSquare,
        },
        {
          id: "orchestrate",
          label: "Orchestrate",
          description: "Run/monitor orchestration workflows.",
          icon: Zap,
        },
        {
          id: "agents",
          label: "Agents",
          description: "See agents status and manage behavior.",
          icon: Bot,
        },
        {
          id: "specialists",
          label: "Specialists",
          description: "AI specialists and task assignment.",
          icon: Brain,
        },
      ],
    },
    {
      label: "Skills & Plugins",
      icon: Puzzle,
      accent: "from-violet-500/20 to-purple-500/20",
      items: [
        {
          id: "skills",
          label: "Skills",
          description: "Skills inventory and toggles.",
          icon: Puzzle,
          badge: stats.loading || stats.failed ? undefined : stats.totalSkills || undefined,
        },
        {
          id: "plugins",
          label: "Plugin Registry",
          description:
            "Browse and manage all installed plugins, skills, and MCP servers.",
          icon: Package,
          badge: stats.loading || stats.failed ? undefined : stats.totalPlugins || undefined,
        },
        {
          id: "mcp-servers",
          label: "MCP Servers",
          description:
            "View MCP server connections — Atlassian, Figma, GitLab, Linear, and more.",
          icon: Plug,
        },
      ],
    },
    {
      label: "AI Configuration",
      icon: Cpu,
      accent: "from-cyan-500/20 to-teal-500/20",
      items: [
        {
          id: "settings",
          label: "API Key Management",
          description:
            "Configure API keys for OpenAI, Anthropic, Google, and other AI providers.",
          icon: Key,
        },
        {
          id: "settings",
          label: "Local AI Models",
          description: "Manage Ollama and other locally-running AI models.",
          icon: Server,
        },
        {
          id: "settings",
          label: "AI Model & Provider",
          description: "Select active model, provider, and fallback config.",
          icon: Cpu,
        },
      ],
    },
    {
      label: "Operations",
      icon: Activity,
      accent: "from-amber-500/20 to-orange-500/20",
      items: [
        {
          id: "approvals",
          label: "Approvals",
          description: "Exec approvals / security center.",
          icon: Shield,
        },
        {
          id: "cron",
          label: "Schedules",
          description: "Cron/scheduler configuration.",
          icon: Clock,
        },
        {
          id: "logs",
          label: "Logs",
          description: "Gateway logs viewer.",
          icon: FileText,
        },
        {
          id: "usage",
          label: "Usage",
          description: "Cost and usage dashboards.",
          icon: DollarSign,
        },
        {
          id: "channels",
          label: "Channels",
          description: "Messaging channels configuration.",
          icon: Radio,
        },
      ],
    },
    {
      label: "Management",
      icon: Settings,
      accent: "from-emerald-500/20 to-green-500/20",
      items: [
        {
          id: "missions",
          label: "Missions",
          description: "Long-running mission definitions.",
          icon: Rocket,
        },
        {
          id: "employees",
          label: "Employees",
          description: "Employee directory and assignments.",
          icon: Users,
        },
        {
          id: "integrations",
          label: "Integrations",
          description: "External systems and tokens.",
          icon: Link2,
        },
        {
          id: "settings",
          label: "Settings",
          description: "OpenClaw Mission Control settings.",
          icon: Settings,
        },
        {
          id: "tools",
          label: "Tools Playground",
          description: "Try tool calls / playground utilities.",
          icon: Wrench,
        },
        {
          id: "learn",
          label: "Learning Hub",
          description: "Curated lessons and build ideas.",
          icon: BookOpen,
        },
      ],
    },
  ];
}

// --- Main Component ---

export function AllToolsView(props: { onNavigate: (viewId: ViewId) => void }) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const stats = useEcosystemStats();
  const gateway = useGatewayHealth();
  const gridRef = useRef<HTMLDivElement>(null);

  const allSections = useMemo(() => buildSections(stats), [stats]);

  const sections = useMemo(() => {
    if (!needle) return allSections;
    return allSections
      .map((s) => ({
        ...s,
        items: s.items.filter((it) => {
          const hay = `${it.label} ${it.description}`.toLowerCase();
          return hay.includes(needle);
        }),
      }))
      .filter((s) => s.items.length > 0);
  }, [needle, allSections]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!gridRef.current) return;
      const buttons = Array.from(
        gridRef.current.querySelectorAll<HTMLButtonElement>("[data-tool-card]")
      );
      const idx = buttons.findIndex((b) => b === document.activeElement);
      if (idx === -1) return;

      let next = idx;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        next = Math.min(idx + 1, buttons.length - 1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        next = Math.max(idx - 1, 0);
      }
      buttons[next]?.focus();
    },
    []
  );

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">All Tools</h1>
          <p className="text-sm text-muted-foreground mt-1">
            The complete tool ecosystem &mdash; every capability, plugin, and
            configuration surface in one place.
          </p>
        </div>

        <div className="w-full sm:w-80 relative flex items-center">
          <Search className="absolute left-3 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools…"
            className="w-full h-10 pl-9 pr-10 rounded-lg border border-border bg-background/60 backdrop-blur-sm focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/50 transition-all"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-3 p-1 rounded-full text-muted-foreground hover:bg-muted focus:outline-none transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Gateway Status Banner */}
      <div className="mt-4">
        <GatewayBanner state={gateway.state} hint={gateway.hint} />
      </div>

      {/* Ecosystem Overview Stats Strip */}
      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="Total Plugins"
          value={stats.totalPlugins}
          icon={Package}
          loading={stats.loading}
          failed={stats.failed}
        />
        <StatCard
          label="Total Skills"
          value={stats.totalSkills}
          icon={Puzzle}
          loading={stats.loading}
          failed={stats.failed}
        />
        <StatCard
          label="MCP Servers"
          value={stats.mcpServers}
          icon={Plug}
          loading={stats.loading}
          failed={stats.failed}
        />
        <StatCard
          label="AI Specialists"
          value={stats.aiSpecialists}
          icon={Brain}
          loading={stats.loading}
          failed={stats.failed}
        />
      </div>

      {/* Category Sections */}
      <div
        ref={gridRef}
        className="mt-6 grid gap-5"
        onKeyDown={handleKeyDown}
      >
        {sections.map((section, sectionIdx) => {
          const SectionIcon = section.icon;
          return (
            <div
              key={section.label}
              className="glass-panel rounded-xl overflow-hidden fade-in"
              style={{ animationDelay: `${sectionIdx * 60}ms`, animationFillMode: "backwards" }}
            >
              {/* Section accent bar */}
              <div className={`h-1 bg-gradient-to-r ${section.accent}`} />

              <div className="p-5">
                {/* Section Header */}
                <div className="flex items-center gap-2.5 mb-4">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-primary/10">
                    <SectionIcon className="w-4 h-4 text-primary" />
                  </div>
                  <span className="text-xs uppercase tracking-wider text-muted-foreground/80 font-semibold">
                    {section.label}
                  </span>
                  <span className="text-[10px] text-muted-foreground/50 font-mono">
                    {section.items.length} {section.items.length === 1 ? "tool" : "tools"}
                  </span>
                </div>

                {/* Cards Grid */}
                <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                  {section.items.map((item, idx) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={`${item.id}-${item.label}-${idx}`}
                        data-tool-card
                        onClick={() => props.onNavigate(item.id)}
                        className="w-full text-left flex items-start gap-3 rounded-lg px-4 py-3.5 border border-border/60 bg-card/40 hover:bg-primary/5 hover:border-primary/30 hover:-translate-y-0.5 hover:shadow-lg focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none transition-all duration-200 group"
                      >
                        <span className="w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0 group-hover:bg-primary/20 group-hover:scale-105 transition-all duration-200">
                          <Icon className="w-5 h-5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate">
                              {item.label}
                            </span>
                            {item.badge !== undefined && (
                              <span className="inline-flex items-center rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px] font-bold tabular-nums">
                                {item.badge}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">
                            {item.description}
                          </div>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}

        {sections.length === 0 && (
          <div className="glass-panel rounded-xl p-8 text-center">
            <Search className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
            <div className="text-sm text-muted-foreground">
              No tools match &quot;{query}&quot;.
            </div>
            <button
              onClick={() => setQuery("")}
              className="mt-3 text-xs text-primary hover:underline"
            >
              Clear search
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
