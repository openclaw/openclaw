"use client";

import { useEffect, useState } from "react";

// --- Types ---

type SessionRow = {
  key: string;
  sessionId: string;
  updatedAt: number;
  label?: string;
  displayName?: string;
  channel?: string;
  model?: string;
  modelProvider?: string;
  thinkingLevel?: string;
  totalTokens?: number;
};

type SkillEntry = {
  name: string;
  description: string;
  emoji?: string;
  source: string;
};

type MemoryFile = {
  name: string;
  sizeBytes: number;
};

type SidebarSection = "sessions" | "skills" | "memories";

// --- Helpers ---

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTokens(n?: number): string {
  if (n == null) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// --- Section Components ---

function SessionsSection({ sessions }: { sessions: SessionRow[] }) {
  if (sessions.length === 0) {
    return <p className="text-sm text-[var(--color-text-muted)] px-3">No sessions found.</p>;
  }

  return (
    <div className="space-y-1">
      {sessions.map((s) => (
        <div
          key={s.key}
          className="px-3 py-2 rounded-lg hover:bg-[var(--color-surface-hover)] cursor-default transition-colors"
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium truncate flex-1 mr-2">
              {s.label ?? s.displayName ?? s.key}
            </span>
            {s.updatedAt && (
              <span className="text-xs text-[var(--color-text-muted)] flex-shrink-0">
                {timeAgo(s.updatedAt)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            {s.channel && (
              <span className="text-xs text-[var(--color-text-muted)]">{s.channel}</span>
            )}
            {s.model && (
              <span className="text-xs text-[var(--color-text-muted)] truncate">
                {s.model}
              </span>
            )}
            {s.totalTokens != null && s.totalTokens > 0 && (
              <span className="text-xs text-[var(--color-text-muted)]">
                {formatTokens(s.totalTokens)} tok
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function SkillsSection({ skills }: { skills: SkillEntry[] }) {
  if (skills.length === 0) {
    return <p className="text-sm text-[var(--color-text-muted)] px-3">No skills found.</p>;
  }

  return (
    <div className="space-y-1">
      {skills.map((skill) => (
        <div
          key={`${skill.source}:${skill.name}`}
          className="px-3 py-2 rounded-lg hover:bg-[var(--color-surface-hover)] transition-colors"
        >
          <div className="flex items-center gap-2">
            {skill.emoji && <span className="text-base">{skill.emoji}</span>}
            <span className="text-sm font-medium">{skill.name}</span>
            <span className="text-xs text-[var(--color-text-muted)] ml-auto">{skill.source}</span>
          </div>
          {skill.description && (
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5 line-clamp-2">
              {skill.description}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function MemoriesSection({
  mainMemory,
  dailyLogs,
}: {
  mainMemory: string | null;
  dailyLogs: MemoryFile[];
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="space-y-2">
      {mainMemory ? (
        <div className="px-3">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] mb-1"
          >
            {expanded ? "Collapse" : "Show"} MEMORY.md ({mainMemory.length} chars)
          </button>
          {expanded && (
            <pre className="text-xs text-[var(--color-text-muted)] bg-[var(--color-bg)] rounded p-2 overflow-auto max-h-64 whitespace-pre-wrap">
              {mainMemory}
            </pre>
          )}
        </div>
      ) : (
        <p className="text-sm text-[var(--color-text-muted)] px-3">No MEMORY.md found.</p>
      )}

      {dailyLogs.length > 0 && (
        <div className="px-3">
          <p className="text-xs text-[var(--color-text-muted)] mb-1">
            Daily logs ({dailyLogs.length})
          </p>
          <div className="space-y-0.5">
            {dailyLogs.slice(0, 10).map((log) => (
              <div
                key={log.name}
                className="text-xs text-[var(--color-text-muted)] flex justify-between"
              >
                <span>{log.name}</span>
                <span>{(log.sizeBytes / 1024).toFixed(1)}kb</span>
              </div>
            ))}
            {dailyLogs.length > 10 && (
              <p className="text-xs text-[var(--color-text-muted)]">
                ...and {dailyLogs.length - 10} more
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Collapsible Header ---

function SectionHeader({
  title,
  count,
  isOpen,
  onToggle,
}: {
  title: string;
  count?: number;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between px-3 py-2 text-sm font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] rounded-lg transition-colors"
    >
      <span>
        {title}
        {count != null && (
          <span className="ml-1.5 text-xs text-[var(--color-text-muted)] font-normal">
            ({count})
          </span>
        )}
      </span>
      <svg
        className={`w-4 h-4 text-[var(--color-text-muted)] transition-transform ${isOpen ? "rotate-180" : ""}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </button>
  );
}

// --- Main Sidebar ---

export function Sidebar() {
  const [openSections, setOpenSections] = useState<Set<SidebarSection>>(
    new Set(["sessions"]),
  );
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [mainMemory, setMainMemory] = useState<string | null>(null);
  const [dailyLogs, setDailyLogs] = useState<MemoryFile[]>([]);
  const [loading, setLoading] = useState(true);

  const toggleSection = (section: SidebarSection) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [sessionsRes, skillsRes, memoriesRes] = await Promise.all([
          fetch("/api/sessions").then((r) => r.json()),
          fetch("/api/skills").then((r) => r.json()),
          fetch("/api/memories").then((r) => r.json()),
        ]);
        setSessions(sessionsRes.sessions ?? []);
        setSkills(skillsRes.skills ?? []);
        setMainMemory(memoriesRes.mainMemory ?? null);
        setDailyLogs(memoriesRes.dailyLogs ?? []);
      } catch (err) {
        console.error("Failed to load sidebar data:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  return (
    <aside className="w-72 h-screen flex flex-col bg-[var(--color-surface)] border-r border-[var(--color-border)] overflow-hidden">
      {/* Header */}
      <div className="px-4 py-4 border-b border-[var(--color-border)]">
        <h1 className="text-base font-bold flex items-center gap-2">
          <span className="text-xl">🦞</span>
          <span>OpenClaw</span>
        </h1>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto py-2 space-y-1">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-5 h-5 border-2 border-[var(--color-border)] border-t-[var(--color-accent)] rounded-full animate-spin" />
          </div>
        ) : (
          <>
            {/* Sessions */}
            <div>
              <SectionHeader
                title="Sessions"
                count={sessions.length}
                isOpen={openSections.has("sessions")}
                onToggle={() => toggleSection("sessions")}
              />
              {openSections.has("sessions") && <SessionsSection sessions={sessions} />}
            </div>

            {/* Skills */}
            <div>
              <SectionHeader
                title="Skills"
                count={skills.length}
                isOpen={openSections.has("skills")}
                onToggle={() => toggleSection("skills")}
              />
              {openSections.has("skills") && <SkillsSection skills={skills} />}
            </div>

            {/* Memories */}
            <div>
              <SectionHeader
                title="Memories"
                count={dailyLogs.length}
                isOpen={openSections.has("memories")}
                onToggle={() => toggleSection("memories")}
              />
              {openSections.has("memories") && (
                <MemoriesSection mainMemory={mainMemory} dailyLogs={dailyLogs} />
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
