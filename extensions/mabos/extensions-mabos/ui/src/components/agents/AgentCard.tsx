import { useNavigate } from "@tanstack/react-router";
import { Brain, Target, Zap, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { getAgentAvatar } from "@/lib/agent-avatars";
import { getAgentIcon, getAgentName } from "@/lib/agent-icons";
import type { AgentListItem, AgentStatus } from "@/lib/types";

type AgentCardProps = {
  agent: AgentListItem;
  onSelect?: (agentId: string) => void;
};

const statusColors: Record<AgentStatus, string> = {
  active: "var(--accent-green)",
  idle: "var(--accent-orange)",
  error: "var(--accent-red)",
  paused: "var(--text-muted)",
};

const statusLabels: Record<AgentStatus, string> = {
  active: "Active",
  idle: "Idle",
  error: "Error",
  paused: "Paused",
};

const autonomyColors: Record<string, string> = {
  low: "var(--accent-blue)",
  medium: "var(--accent-orange)",
  high: "var(--accent-red)",
};

export function AgentCard({ agent, onSelect }: AgentCardProps) {
  const navigate = useNavigate();
  const Icon = getAgentIcon(agent.id);
  const avatar = getAgentAvatar(agent.id);
  const displayName = getAgentName(agent.id);
  const dotColor = statusColors[agent.status];

  return (
    <Card
      className="bg-[var(--bg-card)] border-[var(--border-mabos)] hover:border-[var(--border-hover)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer py-4"
      onClick={() =>
        onSelect
          ? onSelect(agent.id)
          : navigate({ to: "/agents/$agentId", params: { agentId: agent.id } })
      }
    >
      <CardContent className="flex flex-col gap-4">
        {/* Header: icon, name, status */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            {avatar ? (
              <img src={avatar} alt={displayName} className="w-10 h-10 rounded-lg object-cover" />
            ) : (
              <div
                className="flex items-center justify-center w-10 h-10 rounded-lg"
                style={{
                  backgroundColor: `color-mix(in srgb, var(--accent-purple) 15%, transparent)`,
                }}
              >
                <Icon className="w-5 h-5 text-[var(--accent-purple)]" />
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                {displayName}
              </p>
              <p className="text-xs text-[var(--text-muted)] capitalize">{agent.type}</p>
            </div>
          </div>
          <Badge
            variant="outline"
            className="border-[var(--border-mabos)] text-[var(--text-secondary)] text-[10px] px-1.5 py-0 gap-1.5 shrink-0"
          >
            <span
              className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: dotColor }}
            />
            {statusLabels[agent.status]}
          </Badge>
        </div>

        {/* BDI counts */}
        <div className="grid grid-cols-2 gap-2">
          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <Brain className="w-3.5 h-3.5 text-[var(--accent-blue)]" />
            <span>{agent.beliefs} beliefs</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <Sparkles className="w-3.5 h-3.5 text-[var(--accent-purple)]" />
            <span>{agent.desires} desires</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <Target className="w-3.5 h-3.5 text-[var(--accent-green)]" />
            <span>{agent.goals} goals</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <Zap className="w-3.5 h-3.5 text-[var(--accent-orange)]" />
            <span>{agent.intentions} intentions</span>
          </div>
        </div>

        {/* Autonomy level */}
        <div className="flex items-center justify-between pt-2 border-t border-[var(--border-mabos)]">
          <span className="text-xs text-[var(--text-muted)]">Autonomy</span>
          <Badge
            variant="outline"
            className="border-[var(--border-mabos)] text-[10px] px-1.5 py-0 capitalize"
            style={{ color: autonomyColors[agent.autonomy_level] }}
          >
            {agent.autonomy_level}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}
