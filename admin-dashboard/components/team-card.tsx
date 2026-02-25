"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { type Team, type HealthStatus } from "@/lib/teams";
import { SkillManagement } from "./skill-management";

interface TeamCardProps {
  team: Team & { health: HealthStatus };
  isSelected: boolean;
  onSelect: (selected: boolean) => void;
}

export function TeamCard({ team, isSelected, onSelect }: TeamCardProps) {
  const statusColor =
    team.health.status === "online"
      ? "bg-green-500"
      : team.health.status === "loading"
        ? "bg-yellow-500"
        : "bg-red-500";

  const onlineAgents = team.health.agents?.filter((a) => a.status === "online").length || 0;
  const totalAgents = team.health.agents?.length || 0;

  return (
    <Card className="relative">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <Checkbox
              checked={isSelected}
              onCheckedChange={onSelect}
              className="mt-1"
            />
            <CardTitle className="text-lg">{team.owner}</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <div className={`h-3 w-3 rounded-full ${statusColor}`} />
            <Badge variant="outline">{team.subdomain}</Badge>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2 text-sm text-gray-600">
          <span>🌐 {team.lang}</span>
          <span>•</span>
          <span>
            {onlineAgents}/{totalAgents} Agenten online
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div>
            <div className="text-xs font-medium text-gray-500 mb-1">Agenten Status</div>
            <div className="space-y-1">
              {team.health.agents?.map((agent) => (
                <div
                  key={agent.name}
                  className="flex items-center justify-between text-sm"
                >
                  <span>{agent.name}</span>
                  <Badge
                    variant={agent.status === "online" ? "default" : "secondary"}
                    className="text-xs"
                  >
                    {agent.status === "online" ? "🟢" : "🔴"} {agent.status}
                  </Badge>
                </div>
              ))}
              {(!team.health.agents || team.health.agents.length === 0) && (
                <div className="text-sm text-gray-400">Keine Agenten</div>
              )}
            </div>
          </div>

          {team.health.swarm && (
            <div>
              <div className="text-xs font-medium text-gray-500 mb-1">Swarm Status</div>
              <Badge variant="outline">
                {team.health.swarm.active}/{team.health.swarm.total} aktiv
              </Badge>
            </div>
          )}

          <SkillManagement subdomain={team.subdomain} />
        </div>
      </CardContent>
    </Card>
  );
}
