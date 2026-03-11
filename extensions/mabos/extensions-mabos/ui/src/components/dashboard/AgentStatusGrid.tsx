import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getAgentAvatar } from "@/lib/agent-avatars";
import { getAgentIcon, getAgentName } from "@/lib/agent-icons";
import type { AgentListItem, AgentStatus } from "@/lib/types";

type AgentStatusGridProps = {
  agents: AgentListItem[] | undefined;
  isLoading: boolean;
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

function AgentCard({ agent }: { agent: AgentListItem }) {
  const Icon = getAgentIcon(agent.id);
  const avatar = getAgentAvatar(agent.id);
  const displayName = getAgentName(agent.id);
  const dotColor = statusColors[agent.status];

  return (
    <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] hover:border-[var(--border-hover)] transition-colors py-3">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            {avatar ? (
              <img src={avatar} alt={displayName} className="w-8 h-8 rounded-lg object-cover" />
            ) : (
              <div
                className="flex items-center justify-center w-8 h-8 rounded-lg"
                style={{
                  backgroundColor: `color-mix(in srgb, var(--accent-purple) 15%, transparent)`,
                }}
              >
                <Icon className="w-4 h-4 text-[var(--accent-purple)]" />
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                {displayName}
              </p>
              <p className="text-xs text-[var(--text-muted)] truncate capitalize">{agent.type}</p>
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
        <p className="text-xs text-[var(--text-muted)] truncate pl-11">
          {agent.goals} goals · {agent.intentions} intentions
        </p>
      </CardContent>
    </Card>
  );
}

function AgentCardSkeleton() {
  return (
    <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] py-3">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <Skeleton className="w-8 h-8 rounded-lg" />
            <div className="space-y-1.5">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
          <Skeleton className="h-5 w-14 rounded-full" />
        </div>
        <Skeleton className="h-3 w-32 ml-11" />
      </CardContent>
    </Card>
  );
}

export function AgentStatusGrid({ agents, isLoading }: AgentStatusGridProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Agent Status</h2>
        {agents && (
          <p className="text-sm text-[var(--text-muted)]">
            {agents.filter((a) => a.status === "active").length} of {agents.length} active
          </p>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {isLoading
          ? Array.from({ length: 8 }).map((_, i) => <AgentCardSkeleton key={i} />)
          : agents?.map((agent) => <AgentCard key={agent.id} agent={agent} />)}
      </div>
    </div>
  );
}
