"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Search,
  Play,
  Star,
  StarOff,
  Copy,
  Check,
  ChevronRight,
  Loader2,
  Wrench,
  Bot,
  Calendar,
  BarChart3,
  MessageSquare,
  Globe,
  Shield,
  Database,
  Volume2,
  HardDrive,
  FileText,
  Activity,
  Info,
  Lightbulb,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

type ParamDef = {
  name: string;
  label: string;
  type: "text" | "textarea";
  placeholder?: string;
  optional?: boolean;
  help?: string;
};

type ToolCatalogEntry = {
  tool: string; // underscore name (we map to gateway dot method)
  label: string;
  desc: string;
  category: string;
  icon: React.ComponentType<{ className?: string }>;
  params: ParamDef[];
  // Friendly help (for kids/older people)
  whatItDoes: string;
  whenToUse: string[];
  examples?: Array<{ label: string; params: Record<string, string> }>; // quick-fill presets
  links?: Array<{ label: string; viewId: string; note?: string }>;
};

type ToolRunSuccess = {
  ok: true;
  result: unknown;
};

type ToolRunFailure = {
  ok?: false;
  error?: string;
  [key: string]: unknown;
};

type ToolRunResponse = ToolRunSuccess | ToolRunFailure;

// Tool definitions with human-friendly names and categories
const TOOL_CATALOG: ToolCatalogEntry[] = [
  // Sessions
  {
    tool: "sessions_list",
    label: "List Sessions",
    desc: "See all conversations (sessions) currently known to the gateway.",
    category: "Sessions",
    icon: MessageSquare,
    params: [
      {
        name: "agentId",
        label: "Agent (optional)",
        type: "text",
        placeholder: "main",
        optional: true,
        help: "Leave empty to list sessions for all agents. Use this when you have many sessions.",
      },
    ],
    whatItDoes:
      "Shows the list of sessions (conversations). Each session is like a separate memory bubble for the AI.",
    whenToUse: [
      "You forgot where you were chatting (find the right session key).",
      "You want to see what’s active right now.",
      "You want to debug why a view (Chat / Agents) shows something unexpected.",
    ],
    links: [
      { label: "Open Chat", viewId: "chat", note: "Use a session key from here." },
      { label: "Open Logs", viewId: "logs", note: "If a session looks stuck." },
    ],
  },
  {
    tool: "sessions_preview",
    label: "Preview Session",
    desc: "Peek into a session: see the latest messages without opening Chat.",
    category: "Sessions",
    icon: MessageSquare,
    params: [
      {
        name: "keys",
        label: "Session Key",
        type: "text",
        placeholder: "agent:main:main",
        help: "Paste a session key from ‘List Sessions’. Tip: you can paste multiple keys separated by commas.",
      },
    ],
    whatItDoes:
      "Loads a quick preview of recent messages in a session so you can confirm ‘this is the right conversation’.",
    whenToUse: [
      "You have many sessions and want to find the correct one quickly.",
      "You want to audit what the AI said (fast).",
    ],
    examples: [
      {
        label: "Preview main session",
        params: { keys: "agent:main:main" },
      },
    ],
    links: [
      { label: "Open Chat", viewId: "chat", note: "Switch to that session for full context." },
      { label: "Open Agents", viewId: "agents", note: "If you suspect an agent is misbehaving." },
    ],
  },

  // Agents
  {
    tool: "agents_list",
    label: "List Agents",
    desc: "Show all configured AI agents.",
    category: "Agents",
    icon: Bot,
    params: [],
    whatItDoes:
      "Lists every agent you can dispatch tasks to (their IDs, names, and capabilities).",
    whenToUse: [
      "You want to confirm which agents exist.",
      "You’re about to use Specialists or Orchestrate and need an agent id.",
    ],
    links: [
      { label: "Open Specialists", viewId: "specialists" },
      { label: "Open Orchestrate", viewId: "orchestrate" },
    ],
  },

  // Cron / Automation
  {
    tool: "cron_list",
    label: "List Scheduled Tasks",
    desc: "Show all recurring AI tasks (cron jobs).",
    category: "Automation",
    icon: Calendar,
    params: [],
    whatItDoes:
      "Shows all scheduled tasks (like reminders, daily fetches, periodic checks).",
    whenToUse: [
      "You want to see what runs automatically.",
      "You’re debugging unexpected automated messages.",
    ],
    links: [
      { label: "Open Schedules", viewId: "cron" },
      { label: "Open Logs", viewId: "logs" },
    ],
  },
  {
    tool: "cron_status",
    label: "Scheduler Status",
    desc: "Check if the scheduler is running.",
    category: "Automation",
    icon: Calendar,
    params: [],
    whatItDoes:
      "Tells you if the scheduler service is enabled and when the next wake/run is expected.",
    whenToUse: ["Your cron jobs aren’t firing and you want a quick diagnosis."],
    links: [
      { label: "Open Schedules", viewId: "cron" },
      { label: "Open Logs", viewId: "logs", note: "Look for cron errors/warnings." },
    ],
  },

  // Usage
  {
    tool: "usage_status",
    label: "Usage Status",
    desc: "Current token usage and quotas.",
    category: "Usage",
    icon: BarChart3,
    params: [],
    whatItDoes:
      "Shows usage totals and quota/limits (helps explain slowdowns or failures).",
    whenToUse: [
      "The system feels slower than usual.",
      "You want to confirm spending/usage before enabling automations.",
    ],
    links: [{ label: "Open Usage", viewId: "usage" }],
  },
  {
    tool: "usage_cost",
    label: "Usage Cost",
    desc: "Total spending so far.",
    category: "Usage",
    icon: BarChart3,
    params: [],
    whatItDoes:
      "Shows estimated or tracked cost (depends on provider/telemetry availability).",
    whenToUse: ["You want to check burn before running heavy research or automations."],
    links: [{ label: "Open Usage", viewId: "usage" }],
  },

  // System
  {
    tool: "health",
    label: "Health Check",
    desc: "Verify the gateway is alive and responding.",
    category: "System",
    icon: Shield,
    params: [],
    whatItDoes:
      "A quick ‘is it up?’ ping. If this fails, most other tools will fail too.",
    whenToUse: [
      "The dashboard is showing weird/stale data.",
      "Tools Playground is erroring; start here.",
    ],
    links: [{ label: "Open Logs", viewId: "logs" }],
  },
  {
    tool: "status",
    label: "System Status",
    desc: "Full gateway status information.",
    category: "System",
    icon: Activity,
    params: [],
    whatItDoes:
      "Returns detailed status: versions, subsystems, and key runtime state.",
    whenToUse: ["Deep troubleshooting: you need more than a health ping."],
    links: [{ label: "Open Logs", viewId: "logs" }],
  },
  {
    tool: "models_list",
    label: "List Models",
    desc: "Show all available AI models.",
    category: "System",
    icon: Database,
    params: [],
    whatItDoes:
      "Lists models/providers available to the gateway so you can pick the right one in other flows.",
    whenToUse: [
      "You’re configuring agents or troubleshooting model availability.",
      "You want to confirm which models are installed/authorized.",
    ],
    links: [{ label: "Open Settings", viewId: "settings" }],
  },
  {
    tool: "channels_status",
    label: "Channel Status",
    desc: "Status of messaging channels.",
    category: "Channels",
    icon: Globe,
    params: [],
    whatItDoes:
      "Shows if WhatsApp/Telegram/Discord/etc. connectors are connected and healthy.",
    whenToUse: [
      "Messages aren’t coming in.",
      "You changed tokens and want to validate quickly.",
    ],
    links: [{ label: "Open Channels", viewId: "channels" }],
  },
  {
    tool: "skills_status",
    label: "Skills Status",
    desc: "List installed agent skills.",
    category: "System",
    icon: Wrench,
    params: [],
    whatItDoes:
      "Shows which skills are available (camera, web search, TTS, etc.). Skills = what the AI can do.",
    whenToUse: [
      "A feature doesn’t work (e.g., TTS/web search) and you suspect the skill is missing.",
      "You’re setting up a new environment.",
    ],
    links: [{ label: "Open Skills", viewId: "skills" }],
  },
  {
    tool: "logs_tail",
    label: "Recent Logs",
    desc: "Fetch the latest log entries.",
    category: "System",
    icon: FileText,
    params: [],
    whatItDoes:
      "Gets the last chunk of logs. Helpful for quick diagnosis without switching pages.",
    whenToUse: ["Something failed and you want the reason immediately."],
    links: [{ label: "Open Logs", viewId: "logs" }],
  },

  // Nodes (read-only)
  {
    tool: "node_list",
    label: "List Nodes",
    desc: "Show connected devices (nodes) and their capabilities.",
    category: "Nodes",
    icon: HardDrive,
    params: [],
    whatItDoes:
      "Nodes are paired devices (phones/computers) that can run commands, take photos, etc. This is the ‘device list’.",
    whenToUse: [
      "You’re not sure if a phone/device is connected.",
      "You want the node id to inspect it.",
    ],
    links: [{ label: "Open Integrations", viewId: "integrations" }],
  },
  {
    tool: "node_describe",
    label: "Describe Node",
    desc: "Inspect one node in detail.",
    category: "Nodes",
    icon: HardDrive,
    params: [
      {
        name: "node",
        label: "Node Id",
        type: "text",
        placeholder: "iphone-abdul",
        help: "Get the node id from ‘List Nodes’.",
      },
    ],
    whatItDoes:
      "Shows what the node can do (camera, screen, exec, location) and its current status.",
    whenToUse: [
      "A device action fails and you want to confirm permissions/capabilities.",
    ],
    links: [{ label: "Open Logs", viewId: "logs" }],
  },

  // TTS
  {
    tool: "tts_status",
    label: "Text-to-Speech Status",
    desc: "Check if text-to-speech is available and which engine is active.",
    category: "TTS",
    icon: Volume2,
    params: [],
    whatItDoes:
      "Confirms that voice output is configured (so the AI can speak).",
    whenToUse: ["Before using ‘Text to Speech’ or debugging missing audio."],
    links: [{ label: "Open Settings", viewId: "settings" }],
  },
  {
    tool: "tts_providers",
    label: "TTS Providers",
    desc: "List available voice providers (OpenAI, ElevenLabs, Google, etc.).",
    category: "TTS",
    icon: Volume2,
    params: [],
    whatItDoes:
      "Shows the provider options your gateway can use for voice.",
    whenToUse: ["You want to pick a better voice or confirm ElevenLabs is wired."],
    links: [{ label: "Open Settings", viewId: "settings" }],
  },
  {
    tool: "tts_convert",
    label: "Text to Speech",
    desc: "Convert text into spoken audio.",
    category: "TTS",
    icon: Volume2,
    params: [
      {
        name: "text",
        label: "Text to speak",
        type: "textarea",
        placeholder: "Hello! This is OpenClaw Mission Control speaking.",
        help: "Tip: keep it short at first to test. Then use longer scripts.",
      },
      {
        name: "provider",
        label: "Provider (optional)",
        type: "text",
        placeholder: "openai",
        optional: true,
        help: "Leave empty to use your default provider.",
      },
    ],
    whatItDoes:
      "Creates an audio file from text. Great for demos, status readouts, and accessibility.",
    whenToUse: [
      "You want the system to read out alerts.",
      "You want a voice summary of a mission or logs.",
    ],
    examples: [
      {
        label: "Short test",
        params: { text: "Hello! Voice is working.", provider: "" },
      },
      {
        label: "Daily standup",
        params: { text: "Good morning. Today we have 3 urgent tasks and 1 approval pending.", provider: "" },
      },
    ],
    links: [
      { label: "Open Dashboard", viewId: "board", note: "Create a voice daily summary." },
      { label: "Open Logs", viewId: "logs", note: "Turn error logs into a spoken summary." },
    ],
  },
];

const CATEGORIES = ["All", ...Array.from(new Set(TOOL_CATALOG.map((t) => t.category)))];

function navigateTo(viewId: string) {
  if (typeof window === "undefined") return;
  window.location.hash = viewId === "board" ? "" : viewId;
}

function gatewayMethodName(underscoreTool: string) {
  // Map underscored tool name to the gateway method name (dot-separated)
  // e.g. sessions_list -> sessions.list
  return underscoreTool.replace(/_/g, ".");
}

function categoryEmoji(category: string) {
  switch (category) {
    case "System":
      return "🧠";
    case "Sessions":
      return "💬";
    case "Agents":
      return "🤖";
    case "Automation":
      return "⏰";
    case "Usage":
      return "💰";
    case "Channels":
      return "📡";
    case "TTS":
      return "🔊";
    case "Nodes":
      return "📱";
    default:
      return "🧩";
  }
}

function summarizeResult(data: unknown): { title: string; lines: string[] } {
  if (data == null) return { title: "No data", lines: [] };
  if (typeof data === "string") return { title: "Text", lines: [data] };
  if (typeof data === "number" || typeof data === "boolean") {
    return { title: "Value", lines: [String(data)] };
  }
  if (Array.isArray(data)) {
    const preview = data.slice(0, 6).map((v, i) => `#${i + 1}: ${previewOne(v)}`);
    const more = data.length > 6 ? [`…and ${data.length - 6} more`] : [];
    return { title: `List (${data.length})`, lines: [...preview, ...more] };
  }
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const keys = Object.keys(obj);
    const lines = keys.slice(0, 10).map((k) => `${k}: ${previewOne(obj[k])}`);
    const more = keys.length > 10 ? [`…and ${keys.length - 10} more fields`] : [];
    return { title: `Details (${keys.length} fields)`, lines: [...lines, ...more] };
  }
  return { title: "Result", lines: [String(data)] };
}

function previewOne(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string") return value.length > 70 ? `${value.slice(0, 70)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === "object") return "{…}";
  return String(value);
}

interface ToolResult {
  ok: boolean;
  data: unknown;
  duration: number;
  error?: string;
}

export function ToolsPlayground() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [selectedTool, setSelectedTool] = useState(TOOL_CATALOG[0]);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ToolResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [gatewayOk, setGatewayOk] = useState<boolean | null>(null);
  const [gatewayHint, setGatewayHint] = useState<string | null>(null);
  const [simpleMode, setSimpleMode] = useState(true);
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("mc-tool-favorites");
      return saved ? new Set(JSON.parse(saved)) : new Set<string>();
    }
    return new Set<string>();
  });

  const filteredTools = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return TOOL_CATALOG.filter((t) => {
      const matchSearch =
        !needle ||
        t.label.toLowerCase().includes(needle) ||
        t.desc.toLowerCase().includes(needle) ||
        t.whatItDoes.toLowerCase().includes(needle) ||
        t.whenToUse.some((s) => s.toLowerCase().includes(needle));
      const matchCategory = category === "All" || t.category === category;
      return matchSearch && matchCategory;
    });
  }, [search, category]);

  // Sort favorites to top
  const sortedTools = [...filteredTools].sort((a, b) => {
    const af = favorites.has(a.tool) ? 0 : 1;
    const bf = favorites.has(b.tool) ? 0 : 1;
    return af - bf;
  });

  const toggleFavorite = useCallback(
    (tool: string) => {
      setFavorites((prev) => {
        const next = new Set(prev);
        if (next.has(tool)) next.delete(tool);
        else next.add(tool);
        localStorage.setItem("mc-tool-favorites", JSON.stringify([...next]));
        return next;
      });
    },
    []
  );

  const runTool = async () => {
    setLoading(true);
    setResult(null);
    const start = Date.now();
    try {
      const gatewayTool = gatewayMethodName(selectedTool.tool);
      const args: Record<string, unknown> = {};
      selectedTool.params.forEach((p) => {
        const val = paramValues[p.name];
        if (val && val.trim()) {
          // If the param expects an array (like "keys"), split by comma
          if (p.name === "keys") {
            args[p.name] = val
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
          } else {
            args[p.name] = val;
          }
        }
      });

      const res = await fetch("/api/openclaw/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: gatewayTool, args }),
      });

      // Give the user *something* actionable even when the route returns non-JSON.
      const contentType = res.headers.get("content-type") || "";
      const rawText = await res.text();
      const data: ToolRunResponse = contentType.includes("application/json")
        ? (JSON.parse(rawText) as ToolRunResponse)
        : { ok: false, error: rawText.slice(0, 2000) };

      setResult({
        ok: data.ok === true,
        data: data.ok ? data.result : data,
        duration: Date.now() - start,
        error:
          data.ok === true
            ? undefined
            : data.error ||
            (!res.ok ? `HTTP ${res.status} ${res.statusText}` : "Unknown error"),
      });
    } catch (err) {
      setResult({
        ok: false,
        data: null,
        duration: Date.now() - start,
        error: String(err),
      });
    } finally {
      setLoading(false);
    }
  };

  const copyResult = () => {
    if (result) {
      navigator.clipboard.writeText(JSON.stringify(result.data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  useEffect(() => {
    setParamValues({});
    setResult(null);
  }, [selectedTool]);

  // Lightweight connectivity hint for humans: if gateway/tool route is failing,
  // show it clearly so "Run tool" doesn't feel like it did nothing.
  useEffect(() => {
    let cancelled = false;

    const probe = async () => {
      try {
        const res = await fetch("/api/openclaw/tools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool: "health", args: {} }),
        });
        const contentType = res.headers.get("content-type") || "";
        const rawText = await res.text();
        const data = contentType.includes("application/json") ? JSON.parse(rawText) : null;

        if (cancelled) return;
        const ok = Boolean(res.ok && data && data.ok === true);
        setGatewayOk(ok);
        setGatewayHint(
          ok
            ? null
            : data?.error
              ? String(data.error)
              : !res.ok
                ? `Health probe failed (HTTP ${res.status})`
                : "Health probe failed",
        );
      } catch (e) {
        if (cancelled) return;
        setGatewayOk(false);
        setGatewayHint(String(e));
      }
    };

    void probe();
    const id = window.setInterval(probe, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);


  const Icon = selectedTool.icon;

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Left panel — Tool list */}
      <div className="w-80 border-r border-border bg-card/30 flex flex-col shrink-0">
        {/* Search */}
        <div className="p-3 border-b border-border">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tools..."
              maxLength={200}
              className="w-full pl-9 pr-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        {/* Category pills */}
        <div className="px-3 py-2 flex flex-wrap gap-1.5 border-b border-border">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${category === cat
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-accent"
                }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Tool list */}
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-0.5">
            {sortedTools.map((tool) => {
              const TIcon = tool.icon;
              const isActive = selectedTool.tool === tool.tool;
              const isFav = favorites.has(tool.tool);
              return (
                <button
                  key={tool.tool}
                  onClick={() => setSelectedTool(tool)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded text-left text-sm transition-all group ${isActive
                    ? "bg-primary/10 text-primary border border-primary/20"
                    : "hover:bg-accent text-foreground"
                    }`}
                >
                  <TIcon className={`w-4 h-4 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate flex items-center gap-1.5">
                      {isFav && <Star className="w-3 h-3 text-yellow-500 fill-yellow-500 shrink-0" />}
                      <span className="shrink-0">{categoryEmoji(tool.category)}</span>
                      {tool.label}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate">{tool.desc}</div>
                  </div>
                  {isActive && <ChevronRight className="w-4 h-4 text-primary shrink-0" />}
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </div>

      {/* Right panel — Tool details */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Tool header */}
        <div className="p-5 border-b border-border bg-card/30">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3 min-w-[260px]">
              <div className="w-10 h-10 rounded bg-primary/10 flex items-center justify-center">
                <Icon className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h2 className="text-lg font-bold">{selectedTool.label}</h2>
                <p className="text-sm text-muted-foreground">{selectedTool.desc}</p>
                <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                  <span className="inline-flex items-center gap-1">
                    <Info className="w-3.5 h-3.5" />
                    Safe playground (read-only)
                  </span>
                  {!simpleMode && (
                    <>
                      <span className="text-muted-foreground/70">•</span>
                      <span className="inline-flex items-center gap-1 font-mono">
                        <Database className="w-3.5 h-3.5" />
                        {gatewayMethodName(selectedTool.tool)}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => toggleFavorite(selectedTool.tool)}
                className="p-2 rounded hover:bg-accent transition-colors"
                title={favorites.has(selectedTool.tool) ? "Remove from favorites" : "Add to favorites"}
              >
                {favorites.has(selectedTool.tool) ? (
                  <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />
                ) : (
                  <StarOff className="w-4 h-4 text-muted-foreground" />
                )}
              </button>
              <Badge variant="secondary" className="text-[11px]">
                {categoryEmoji(selectedTool.category)} {selectedTool.category}
              </Badge>
              <button
                onClick={() => setSimpleMode((s) => !s)}
                className={`px-3 py-1.5 rounded-md border text-xs font-semibold transition ${simpleMode
                  ? "bg-primary/10 text-primary border-primary/25 hover:bg-primary/15"
                  : "bg-card/40 text-muted-foreground border-border hover:text-foreground"
                  }`}
                title="Toggle Simple / Advanced view"
              >
                {simpleMode ? "👶 Simple" : "🧑‍💻 Advanced"}
              </button>
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-5">
            {/* Gateway connection hint */}
            <div className="mb-5">
              {gatewayOk === null ? (
                <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2 animate-pulse">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Checking gateway connection…
                  </div>
                  <div className="h-3 bg-muted rounded w-3/4" />
                  <div className="h-3 bg-muted rounded w-1/2" />
                </div>
              ) : gatewayOk ? (
                <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-green-500/5 border border-green-500/20 text-sm">
                  <div className="relative flex items-center justify-center">
                    <span className="w-2 h-2 rounded-full bg-green-500" />
                    <span className="absolute w-2 h-2 rounded-full bg-green-500 ping-slow" />
                  </div>
                  <Check className="w-4 h-4 text-green-500" />
                  <span className="text-green-600 dark:text-green-400 font-medium">Gateway connected</span>
                </div>
              ) : (
                <div className="rounded-xl border-2 border-destructive/30 bg-destructive/5 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
                    <Shield className="w-5 h-5" />
                    Tools Playground can&apos;t reach the gateway
                  </div>
                  <div className="text-xs text-muted-foreground mt-2 leading-relaxed">
                    {gatewayHint ||
                      "Check that OpenClaw Gateway is running and that OpenClaw Mission Control can connect."}
                  </div>
                  <div className="mt-3 flex gap-2 flex-wrap">
                    <button
                      onClick={() => navigateTo("logs")}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-card/40 hover:bg-primary/5 hover:border-primary/30 transition text-sm"
                    >
                      Open Logs <ArrowRight className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => navigateTo("settings")}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-card/40 hover:bg-primary/5 hover:border-primary/30 transition text-sm"
                    >
                      Open Settings <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* What you are running (super simple) */}
            <div className="glass-panel rounded-lg p-4 mb-4">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  <Wrench className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <div className="font-semibold text-base">
                    You are about to run: {selectedTool.label} {categoryEmoji(selectedTool.category)}
                  </div>
                  <div className="text-sm text-muted-foreground mt-1 leading-relaxed">
                    This sends a <span className="font-semibold">safe read-only</span> request to the OpenClaw Gateway and shows the answer here.
                    {simpleMode ? "" : " (Advanced shows the raw method name + JSON.)"}
                  </div>
                </div>
              </div>
            </div>

            {/* Friendly explainer */}
            <div className="glass-panel rounded-lg p-4 mb-6">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  <Lightbulb className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <div className="font-semibold">What this tool does</div>
                  <div className="text-sm text-muted-foreground mt-1 leading-relaxed">
                    {selectedTool.whatItDoes}
                  </div>
                  {selectedTool.whenToUse.length > 0 && (
                    <div className="mt-3">
                      <div className="text-xs uppercase tracking-wider text-muted-foreground/80 font-semibold">
                        When to use it
                      </div>
                      <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
                        {selectedTool.whenToUse.map((idea) => (
                          <li key={idea} className="flex gap-2">
                            <span className="mt-1 w-1.5 h-1.5 rounded-full bg-primary/70 shrink-0" />
                            <span className="leading-relaxed">{idea}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {selectedTool.links && selectedTool.links.length > 0 && (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {selectedTool.links.map((l) => (
                        <button
                          key={`${selectedTool.tool}:${l.viewId}`}
                          onClick={() => navigateTo(l.viewId)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-card/40 hover:bg-primary/5 hover:border-primary/30 transition text-sm"
                          title={l.note || ""}
                        >
                          <span>{l.label}</span>
                          <ArrowRight className="w-4 h-4" />
                        </button>
                      ))}
                    </div>
                  )}

                  {selectedTool.examples && selectedTool.examples.length > 0 && (
                    <div className="mt-4">
                      <div className="text-xs uppercase tracking-wider text-muted-foreground/80 font-semibold">
                        Quick examples
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {selectedTool.examples.map((ex) => (
                          <button
                            key={`${selectedTool.tool}:${ex.label}`}
                            onClick={() => setParamValues(ex.params)}
                            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-primary/10 text-primary hover:bg-primary/15 transition text-sm"
                          >
                            <span className="font-medium">{ex.label}</span>
                            <span className="text-primary/70">(fill)</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Parameters */}
            {selectedTool.params.length > 0 && (
              <div className="mb-6">
                <h3 className="text-sm font-bold uppercase text-muted-foreground mb-3 tracking-wider">
                  Parameters
                </h3>
                <div className="space-y-4">
                  {selectedTool.params.map((param) => (
                    <div key={param.name} className="glass-card p-3">
                      <label className="block text-sm font-medium mb-1.5">
                        {param.label}
                        {param.optional && (
                          <span className="text-muted-foreground text-xs ml-1">(optional)</span>
                        )}
                      </label>
                      {param.help && (
                        <div className="text-xs text-muted-foreground mb-2 leading-relaxed">
                          {param.help}
                        </div>
                      )}
                      {param.type === "textarea" ? (
                        <textarea
                          value={paramValues[param.name] || ""}
                          onChange={(e) =>
                            setParamValues((prev) => ({
                              ...prev,
                              [param.name]: e.target.value,
                            }))
                          }
                          placeholder={param.placeholder || ""}
                          maxLength={5000}
                          rows={4}
                          className="w-full px-3 py-2 bg-background border border-border rounded text-base sm:text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary resize-y"
                        />
                      ) : (
                        <input
                          type="text"
                          value={paramValues[param.name] || ""}
                          onChange={(e) =>
                            setParamValues((prev) => ({
                              ...prev,
                              [param.name]: e.target.value,
                            }))
                          }
                          placeholder={param.placeholder || ""}
                          maxLength={1000}
                          className="w-full px-3 py-2 bg-background border border-border rounded text-base sm:text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Run button */}
            <div className="flex items-center gap-3 mb-6 flex-wrap">
              <Button
                onClick={runTool}
                disabled={loading || gatewayOk === false}
                className="gap-2"
                title={gatewayOk === false ? "Gateway is offline — cannot run tools" : undefined}
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                {loading ? "Running…" : gatewayOk === false ? "Gateway offline" : "Run tool"}
              </Button>
              <div className="text-xs text-muted-foreground flex items-center gap-2">
                <Shield className="w-4 h-4" />
                Read-only tools only (safe)
              </div>
            </div>

            {/* Result */}
            {result && (
              <div>
                <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                  <h3 className="text-sm font-bold uppercase text-muted-foreground tracking-wider">
                    Result
                  </h3>
                  <div className="flex items-center gap-3 text-xs">
                    <Badge
                      variant={result.ok ? "default" : "destructive"}
                      className="text-[10px]"
                    >
                      {result.ok ? "✅ Success" : "❌ Error"}
                    </Badge>
                    <span className="text-muted-foreground font-mono">{result.duration}ms</span>
                    <button
                      onClick={copyResult}
                      className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
                      title="Copy raw result JSON"
                    >
                      {copied ? (
                        <Check className="w-3.5 h-3.5 text-green-500" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      {copied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                </div>

                {simpleMode ? (
                  <div className={`rounded-lg border p-4 ${result.ok ? "border-border bg-card/40" : "border-destructive/30 bg-destructive/5"}`}>
                    {result.ok ? (
                      (() => {
                        const summary = summarizeResult(result.data);
                        return (
                          <>
                            <div className="flex items-center gap-2 font-semibold">
                              <Check className="w-4 h-4 text-green-500" />
                              {summary.title}
                            </div>
                            {summary.lines.length > 0 && (
                              <div className="mt-3 grid gap-1.5 text-sm text-muted-foreground">
                                {summary.lines.map((line) => (
                                  <div key={line} className="font-mono text-xs sm:text-sm break-words">
                                    {line}
                                  </div>
                                ))}
                              </div>
                            )}
                            <details className="mt-4">
                              <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                                🧾 Show raw JSON
                              </summary>
                              <pre className="mt-2 bg-muted/50 rounded border border-border p-3 text-xs sm:text-sm font-mono overflow-x-auto whitespace-pre-wrap max-h-[520px] overflow-y-auto overscroll-contain">
                                {JSON.stringify(result.data, null, 2)}
                              </pre>
                            </details>
                          </>
                        );
                      })()
                    ) : (
                      <>
                        <div className="flex items-center gap-2 font-semibold text-destructive">
                          <Shield className="w-4 h-4" />
                          Something went wrong
                        </div>
                        <div className="text-sm text-muted-foreground mt-2">
                          {result.error || "Unknown error"}
                        </div>
                        <details className="mt-3">
                          <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                            🧾 Show raw response
                          </summary>
                          <pre className="mt-2 bg-muted/50 rounded border border-border p-3 text-xs sm:text-sm font-mono overflow-x-auto whitespace-pre-wrap max-h-[520px] overflow-y-auto overscroll-contain">
                            {JSON.stringify(result.data, null, 2)}
                          </pre>
                        </details>
                      </>
                    )}
                  </div>
                ) : (
                  <pre className="bg-muted/50 rounded border border-border p-4 text-xs sm:text-sm font-mono overflow-x-auto whitespace-pre-wrap max-h-[520px] overflow-y-auto overscroll-contain">
                    {result.error ? result.error : JSON.stringify(result.data, null, 2)}
                  </pre>
                )}
              </div>
            )}

            {/* Empty state */}
            {!result && !loading && (
              <div className="text-center py-12 text-muted-foreground">
                <Wrench className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p className="text-sm">
                  Select a tool and press <strong>Run tool</strong> to see results.
                </p>
                <p className="text-xs mt-2 text-muted-foreground/80">
                  Tip: start with <span className="font-medium">Health Check</span> if you’re unsure.
                </p>
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
