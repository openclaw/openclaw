"use client";

import { useAutoRefresh } from "@/hooks/use-auto-refresh";
import { GlassCard } from "@/components/ui/glass-card";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonCard } from "@/components/ui/skeleton-card";
import { StaggerGrid, StaggerItem } from "@/components/ui/stagger-grid";
import { StatusDot } from "@/components/ui/status-dot";
import { GitBranch, Code2, FileWarning, Clock } from "lucide-react";
import { formatRelativeTime } from "@/lib/utils";
import type { Repository } from "@/lib/types";

export function CodePipeline() {
  const { data: repos, loading } = useAutoRefresh<Repository[]>("/api/repos");

  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} lines={3} />
        ))}
      </div>
    );
  }

  if (!repos?.length) {
    return (
      <GlassCard>
        <EmptyState
          icon={Code2}
          title="No repositories found"
          description="Scanning ~/OpenClaw/ and ~/Desktop/Projects/ for git repos."
        />
      </GlassCard>
    );
  }

  return (
    <StaggerGrid columns="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
      {repos.map((repo) => (
        <StaggerItem key={repo.path}>
          <GlassCard hover>
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-2">
                <Code2 className="w-4 h-4 text-primary" />
                <h3 className="text-sm font-semibold">{repo.name}</h3>
              </div>
              {repo.dirtyFiles !== undefined && repo.dirtyFiles > 0 && (
                <div className="flex items-center gap-1">
                  <FileWarning className="w-3 h-3 text-amber-400" />
                  <span className="text-[10px] text-amber-400 font-mono">{repo.dirtyFiles}</span>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              {repo.branch && (
                <div className="flex items-center gap-1.5">
                  <GitBranch className="w-3 h-3 text-muted-foreground" />
                  <span className="text-[11px] font-mono text-foreground/80">{repo.branch}</span>
                  <StatusDot color={repo.dirtyFiles ? "yellow" : "green"} />
                </div>
              )}

              {repo.lastCommitMessage && (
                <p className="text-[10px] text-muted-foreground truncate pl-[18px]">
                  {repo.lastCommitMessage}
                </p>
              )}

              {repo.lastCommit && (
                <div className="flex items-center gap-1 pl-[18px]">
                  <Clock className="w-3 h-3 text-muted-foreground" />
                  <span className="text-[10px] text-muted-foreground">
                    {formatRelativeTime(repo.lastCommit)}
                  </span>
                </div>
              )}
            </div>
          </GlassCard>
        </StaggerItem>
      ))}
    </StaggerGrid>
  );
}
