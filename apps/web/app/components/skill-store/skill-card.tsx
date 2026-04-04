"use client";

import { useState, type ReactNode } from "react";

export type InstalledSkillData = {
  name: string;
  slug: string;
  description: string;
  emoji?: string;
  source: string;
  filePath: string;
  protected: boolean;
};

export type BrowseSkillData = {
  slug: string;
  displayName: string;
  summary: string;
  installs: number;
  source: string;
};

type InstallPhase = "installing" | "refreshing" | "success" | "error";

export type InstallStatus = {
  phase: InstallPhase;
  message: string;
};

function formatInstalls(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

function orgFromSource(source: string): string {
  const parts = source.split("/");
  return parts[0] ?? source;
}

function orgAvatarUrl(source: string): string {
  const org = orgFromSource(source);
  return `https://github.com/${org}.png?size=80`;
}

const WORKSPACE_SKILL_ICON_SRC = "/icons/folder.png";

function AvatarImg({ source, size = 36, emoji, isManaged }: { source: string; size?: number; emoji?: string; isManaged?: boolean }) {
  const [failed, setFailed] = useState(false);
  const dim = `${size}px`;

  if (isManaged) {
    return (
      <img
        src="/dench-workspace-icon.png"
        alt="DenchClaw"
        width={size}
        height={size}
        className="rounded-xl shrink-0"
        style={{ width: dim, height: dim, objectFit: "cover" }}
        loading="lazy"
      />
    );
  }

  if (emoji && !failed) {
    return (
      <div
        className="flex items-center justify-center rounded-xl shrink-0"
        style={{
          width: dim,
          height: dim,
          background: "var(--color-surface-hover)",
          fontSize: `${Math.round(size * 0.5)}px`,
        }}
      >
        {emoji}
      </div>
    );
  }

  if (source === "workspace") {
    return (
      <img
        src={WORKSPACE_SKILL_ICON_SRC}
        alt=""
        width={size}
        height={size}
        className="rounded-xl shrink-0"
        style={{ width: dim, height: dim, objectFit: "cover" }}
        loading="lazy"
      />
    );
  }

  if (failed) {
    return (
      <div
        className="flex items-center justify-center rounded-xl shrink-0"
        style={{
          width: dim,
          height: dim,
          background: "var(--color-surface-hover)",
          color: "var(--color-text-muted)",
          fontSize: `${Math.round(size * 0.35)}px`,
          fontWeight: 600,
        }}
      >
        {orgFromSource(source).slice(0, 2).toUpperCase()}
      </div>
    );
  }

  return (
    <img
      src={orgAvatarUrl(source)}
      alt=""
      width={size}
      height={size}
      className="rounded-xl shrink-0"
      style={{ width: dim, height: dim, objectFit: "cover" }}
      onError={() => setFailed(true)}
      loading="lazy"
    />
  );
}

function TrendingIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: "inline", verticalAlign: "middle" }}>
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
      <polyline points="17 6 23 6 23 12" />
    </svg>
  );
}

function ArrowUpRightIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: "inline", verticalAlign: "middle" }}>
      <line x1="7" y1="17" x2="17" y2="7" />
      <polyline points="7 7 17 7 17 17" />
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

function DownloadIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: "inline", verticalAlign: "middle" }}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

export function InstalledSkillCard({
  skill,
  removingSlug,
  confirmRemove,
  onConfirmRemove,
  onRemove,
  onClick,
}: {
  skill: InstalledSkillData;
  removingSlug: string | null;
  confirmRemove: string | null;
  onConfirmRemove: (slug: string | null) => void;
  onRemove: (slug: string) => void;
  onClick?: () => void;
}) {
  return (
    <div
      className="group rounded-2xl p-4 flex flex-col gap-2.5 transition-colors cursor-pointer"
      style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick?.(); }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <AvatarImg source={skill.source} emoji={skill.emoji} size={36} isManaged={skill.protected || skill.source === "managed"} />
          <div className="min-w-0">
            <div className="text-sm font-medium truncate" style={{ color: "var(--color-text)" }}>
              {skill.name}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-[10px] truncate" style={{ color: "var(--color-text-muted)" }}>
                {skill.source === "managed" ? "DenchClaw" : orgFromSource(skill.source)}
              </span>
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0"
                style={{
                  background: skill.source === "managed"
                    ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
                    : "var(--color-surface-hover)",
                  color: skill.source === "managed"
                    ? "var(--color-accent)"
                    : "var(--color-text-muted)",
                }}
              >
                {skill.source === "managed" ? "built-in" : skill.source}
              </span>
              {skill.protected && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-1 shrink-0"
                  style={{
                    background: "color-mix(in srgb, var(--color-warning, #f59e0b) 12%, transparent)",
                    color: "var(--color-warning, #f59e0b)",
                  }}
                  title="Required by DenchClaw"
                >
                  <LockIcon />
                  protected
                </span>
              )}
            </div>
          </div>
        </div>

        {!skill.protected && (
          <div className="flex-shrink-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
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
                      <span className="w-3 h-3 border border-current rounded-full animate-spin" style={{ borderTopColor: "transparent" }} />
                      Removing...
                    </span>
                  ) : "Confirm"}
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
                className="text-[11px] px-2 py-1 rounded-lg cursor-pointer transition-opacity opacity-0 group-hover:opacity-100"
                style={{ color: "var(--color-text-muted)" }}
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
  );
}

export function BrowseSkillCard({
  skill,
  isInstalled,
  installStatus,
  onInstall,
  featured = false,
}: {
  skill: BrowseSkillData;
  isInstalled: boolean;
  installStatus?: InstallStatus;
  onInstall: () => void;
  featured?: boolean;
}) {
  const isWorking = installStatus?.phase === "installing" || installStatus?.phase === "refreshing";
  const isTrending = skill.installs >= 50_000;

  return (
    <div
      className="group rounded-2xl p-4 flex flex-col gap-2.5"
      style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <AvatarImg source={skill.source} size={featured ? 40 : 36} />
          <div className="min-w-0">
            <div
              className={`font-medium truncate ${featured ? "text-sm" : "text-sm"}`}
              style={{ color: "var(--color-text)" }}
            >
              {skill.displayName}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-[10px] truncate" style={{ color: "var(--color-text-muted)" }}>
                {orgFromSource(skill.source)}
              </span>
              {skill.installs > 0 && (
                <span
                  className="text-[10px] flex items-center gap-0.5 shrink-0"
                  style={{
                    color: isTrending ? "var(--color-accent)" : "var(--color-text-muted)",
                  }}
                >
                  {isTrending ? <TrendingIcon /> : <DownloadIcon />}
                  {" "}{formatInstalls(skill.installs)}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex-shrink-0">
          {isInstalled ? (
            <span
              className="text-[11px] px-2.5 py-1 rounded-lg"
              style={{
                background: "color-mix(in srgb, var(--color-success, #22c55e) 12%, transparent)",
                color: "var(--color-success, #22c55e)",
              }}
            >
              Installed
            </span>
          ) : isWorking ? (
            <span
              className="text-[11px] px-2.5 py-1 rounded-lg flex items-center gap-1"
              style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
            >
              <span className="w-3 h-3 border border-current rounded-full animate-spin" style={{ borderTopColor: "transparent" }} />
              {installStatus?.phase === "installing" ? "Installing..." : "Syncing..."}
            </span>
          ) : (
            <button
              type="button"
              onClick={onInstall}
              className="text-[11px] px-2.5 py-1 rounded-lg cursor-pointer transition-opacity opacity-0 group-hover:opacity-100 flex items-center gap-1"
              style={{ background: "var(--color-surface-hover)", color: "var(--color-text)" }}
            >
              <ArrowUpRightIcon /> Install
            </button>
          )}
        </div>
      </div>

      {skill.summary && !installStatus && (
        <p className="text-xs leading-relaxed line-clamp-2" style={{ color: "var(--color-text-muted)" }}>
          {skill.summary}
        </p>
      )}

      {installStatus && (
        <p
          className="text-[11px]"
          style={{
            color: installStatus.phase === "error"
              ? "var(--color-error, #ef4444)"
              : "var(--color-text-muted)",
          }}
        >
          {installStatus.message}
        </p>
      )}
    </div>
  );
}

export function StatusNotice({ tone, children }: { tone: "info" | "success" | "error"; children: ReactNode }) {
  const styles = {
    info: {
      background: "color-mix(in srgb, var(--color-accent) 10%, transparent)",
      color: "var(--color-text)",
      border: "1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)",
    },
    success: {
      background: "color-mix(in srgb, var(--color-success, #22c55e) 12%, transparent)",
      color: "var(--color-success, #22c55e)",
      border: "1px solid color-mix(in srgb, var(--color-success, #22c55e) 28%, transparent)",
    },
    error: {
      background: "color-mix(in srgb, var(--color-error, #ef4444) 12%, transparent)",
      color: "var(--color-error, #ef4444)",
      border: "1px solid color-mix(in srgb, var(--color-error, #ef4444) 28%, transparent)",
    },
  }[tone];

  return (
    <div className="rounded-xl px-3 py-2 text-sm" style={styles}>
      {children}
    </div>
  );
}
