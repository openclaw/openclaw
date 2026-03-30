import { useNavigate } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Users,
  Shield,
  Wallet,
  Search,
  Sparkles,
  Brain,
  Terminal,
  FileSearch,
} from "lucide-react";
import { useState, useEffect, useCallback, useRef } from "react";

type PaletteCommand = {
  id: string;
  label: string;
  section: string;
  icon: React.ComponentType<{ className?: string }>;
  action: () => void;
  keywords?: string[];
};

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const commands: PaletteCommand[] = [
    // Navigation
    {
      id: "nav-overview",
      label: "Go to Overview",
      section: "Navigation",
      icon: LayoutDashboard,
      action: () => navigate({ to: "/" }),
      keywords: ["dashboard", "home"],
    },
    {
      id: "nav-agents",
      label: "Go to Agents",
      section: "Navigation",
      icon: Users,
      action: () => navigate({ to: "/agents" }),
      keywords: ["team"],
    },
    {
      id: "nav-governance",
      label: "Go to Governance",
      section: "Navigation",
      icon: Wallet,
      action: () => navigate({ to: "/governance" }),
      keywords: ["budget", "audit"],
    },
    {
      id: "nav-skills",
      label: "Go to Skills",
      section: "Navigation",
      icon: Sparkles,
      action: () => navigate({ to: "/skills" }),
      keywords: ["marketplace"],
    },
    {
      id: "nav-sessions",
      label: "Go to Sessions",
      section: "Navigation",
      icon: FileSearch,
      action: () => navigate({ to: "/sessions" }),
      keywords: ["search", "history"],
    },
    {
      id: "nav-security",
      label: "Go to Security",
      section: "Navigation",
      icon: Shield,
      action: () => navigate({ to: "/security" }),
      keywords: ["threats", "approvals"],
    },

    // Agent actions
    {
      id: "agent-list",
      label: "List All Agents",
      section: "Agents",
      icon: Users,
      action: () => navigate({ to: "/agents" }),
    },

    // Model actions
    {
      id: "model-list",
      label: "View Available Models",
      section: "Models",
      icon: Brain,
      action: () => navigate({ to: "/governance" }),
      keywords: ["pricing", "providers"],
    },

    // Tool actions
    {
      id: "tool-sandbox",
      label: "Open Sandbox",
      section: "Tools",
      icon: Terminal,
      action: () => navigate({ to: "/governance" }),
      keywords: ["execute", "docker"],
    },
  ];

  const filtered = query.trim()
    ? commands.filter((cmd) => {
        const q = query.toLowerCase();
        return (
          cmd.label.toLowerCase().includes(q) ||
          cmd.section.toLowerCase().includes(q) ||
          cmd.keywords?.some((k) => k.includes(q))
        );
      })
    : commands;

  const grouped = filtered.reduce<Record<string, PaletteCommand[]>>((acc, cmd) => {
    (acc[cmd.section] ??= []).push(cmd);
    return acc;
  }, {});

  // Keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
        setQuery("");
        setSelectedIndex(0);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  // Focus input when opened
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && filtered[selectedIndex]) {
        e.preventDefault();
        filtered[selectedIndex].action();
        setOpen(false);
      }
    },
    [filtered, selectedIndex],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />

      {/* Palette */}
      <div
        className="relative w-full max-w-lg rounded-xl border shadow-2xl overflow-hidden"
        style={{
          backgroundColor: "var(--bg-secondary)",
          borderColor: "var(--border-mabos)",
        }}
      >
        {/* Search input */}
        <div
          className="flex items-center gap-3 px-4 py-3 border-b"
          style={{ borderColor: "var(--border-mabos)" }}
        >
          <Search className="h-4 w-4 shrink-0" style={{ color: "var(--text-secondary)" }} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or search..."
            className="flex-1 bg-transparent text-sm outline-none"
            style={{ color: "var(--text-primary)" }}
          />
          <kbd
            className="hidden sm:inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-mono"
            style={{ borderColor: "var(--border-mabos)", color: "var(--text-secondary)" }}
          >
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <div
              className="px-4 py-8 text-center text-sm"
              style={{ color: "var(--text-secondary)" }}
            >
              No commands found.
            </div>
          ) : (
            Object.entries(grouped).map(([section, cmds]) => (
              <div key={section}>
                <div
                  className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {section}
                </div>
                {cmds.map((cmd) => {
                  const idx = filtered.indexOf(cmd);
                  const Icon = cmd.icon;
                  return (
                    <button
                      key={cmd.id}
                      onClick={() => {
                        cmd.action();
                        setOpen(false);
                      }}
                      className="flex w-full items-center gap-3 px-4 py-2 text-sm transition-colors"
                      style={{
                        color: "var(--text-primary)",
                        backgroundColor:
                          idx === selectedIndex
                            ? "color-mix(in srgb, var(--accent-purple) 15%, transparent)"
                            : "transparent",
                      }}
                    >
                      <Icon
                        className="h-4 w-4 shrink-0"
                        style={{ color: "var(--accent-purple)" }}
                      />
                      {cmd.label}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center gap-4 border-t px-4 py-2 text-[11px]"
          style={{ borderColor: "var(--border-mabos)", color: "var(--text-secondary)" }}
        >
          <span>
            <kbd className="font-mono">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="font-mono">↵</kbd> select
          </span>
          <span>
            <kbd className="font-mono">esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
