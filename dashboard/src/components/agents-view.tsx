"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAutoRefresh } from "@/hooks/use-auto-refresh";
import { GlassCard } from "@/components/ui/glass-card";
import { SkeletonCard } from "@/components/ui/skeleton-card";
import { StaggerGrid, StaggerItem } from "@/components/ui/stagger-grid";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Bot,
  ChevronRight,
  Cpu,
  Wrench,
  X,
  MessageSquare,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { scaleIn } from "@/lib/motion";

interface Agent {
  id: string;
  name: string;
  emoji: string;
  role: string;
  level: string;
  model: string;
  modelFull: string;
  status: string;
  tools: string[];
  heartbeat: { every: string; target?: string } | null;
  canSpawnSubagents: boolean;
}

interface AgentDetail {
  id: string;
  name: string;
  soul?: string;
  rules?: string;
  models: unknown;
  sessionCount?: number;
  recentOutputs?: string[];
}

const levelColors: Record<string, string> = {
  L1: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  L2: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  L3: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  L4: "bg-amber-500/10 text-amber-400 border-amber-500/20",
};

export function AgentsView() {
  const { data: agents, loading } = useAutoRefresh<Agent[]>("/api/agents");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  async function selectAgent(id: string) {
    setSelectedAgent(id);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/agents/${id}`);
      const json = await res.json();
      setDetail(json.data || json);
    } catch {
      setDetail(null);
    }
    setDetailLoading(false);
  }

  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} lines={3} />
        ))}
      </div>
    );
  }

  if (!agents?.length) {
    return <EmptyState icon={Bot} title="No agents found" description="Agent configuration not found at openclaw.json" />;
  }

  return (
    <div className="flex gap-4">
      {/* Agent grid */}
      <div className={cn("flex-1 transition-all", selectedAgent ? "lg:w-1/2" : "w-full")}>
        <StaggerGrid columns="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <StaggerItem key={agent.id}>
              <GlassCard
                hover
                padding="sm"
                onClick={() => selectAgent(agent.id)}
                className={cn(
                  selectedAgent === agent.id && "border-primary/30 bg-primary/[0.04]"
                )}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{agent.emoji}</span>
                    <div>
                      <p className="text-sm font-semibold">{agent.name}</p>
                      <p className="text-[10px] text-muted-foreground">{agent.role}</p>
                    </div>
                  </div>
                  <span
                    className={cn(
                      "inline-flex px-1.5 py-0.5 text-[9px] font-bold rounded-md border",
                      levelColors[agent.level] || levelColors.L1
                    )}
                  >
                    {agent.level}
                  </span>
                </div>

                <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <Cpu className="w-3 h-3" />
                    <span className="font-mono">{agent.model}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Wrench className="w-3 h-3" />
                    <span>{agent.tools.length} tools</span>
                  </div>
                  {agent.canSpawnSubagents && (
                    <div className="flex items-center gap-1">
                      <Zap className="w-3 h-3 text-amber-400" />
                    </div>
                  )}
                </div>

                {agent.heartbeat && (
                  <div className="mt-2 text-[9px] text-muted-foreground flex items-center gap-1">
                    <MessageSquare className="w-3 h-3" />
                    <span>Every {agent.heartbeat.every} → {agent.heartbeat.target}</span>
                  </div>
                )}

                <ChevronRight className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/40" />
              </GlassCard>
            </StaggerItem>
          ))}
        </StaggerGrid>
      </div>

      {/* Detail panel */}
      <AnimatePresence>
        {selectedAgent && (
          <motion.div
            variants={scaleIn}
            initial="initial"
            animate="animate"
            exit="initial"
            className="hidden lg:block w-[400px] shrink-0"
          >
            <GlassCard className="sticky top-16">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold">
                  {detail?.name || selectedAgent} — Detail
                </h3>
                <button
                  onClick={() => setSelectedAgent(null)}
                  className="p-1 rounded-md hover:bg-white/[0.06] transition-colors"
                >
                  <X className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>

              {detailLoading ? (
                <div className="space-y-3">
                  <div className="h-3 w-24 bg-white/[0.06] rounded animate-pulse" />
                  <div className="h-20 bg-white/[0.04] rounded animate-pulse" />
                </div>
              ) : detail ? (
                <div className="space-y-4 max-h-[calc(100vh-140px)] overflow-y-auto">
                  {detail.sessionCount !== undefined && (
                    <div className="text-[11px] text-muted-foreground">
                      {detail.sessionCount} active sessions
                    </div>
                  )}

                  {detail.soul && (
                    <div>
                      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                        Personality (SOUL)
                      </h4>
                      <pre className="text-[11px] text-foreground/70 whitespace-pre-wrap font-sans leading-relaxed bg-white/[0.02] rounded-lg p-3 max-h-48 overflow-y-auto">
                        {detail.soul.slice(0, 1000)}
                      </pre>
                    </div>
                  )}

                  {detail.rules && (
                    <div>
                      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                        Rules
                      </h4>
                      <pre className="text-[11px] text-foreground/70 whitespace-pre-wrap font-sans leading-relaxed bg-white/[0.02] rounded-lg p-3 max-h-48 overflow-y-auto">
                        {detail.rules.slice(0, 1000)}
                      </pre>
                    </div>
                  )}

                  {!detail.soul && !detail.rules && (
                    <p className="text-xs text-muted-foreground">
                      No SOUL.md or RULES.md found for this agent.
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Failed to load agent details.</p>
              )}
            </GlassCard>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
