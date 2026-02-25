"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchAllHealth } from "@/lib/api";
import { TEAM_DATA, type Team, type HealthStatus } from "@/lib/teams";
import { TeamCard } from "@/components/team-card";
import { Header } from "@/components/header";
import { MultiSelectActions } from "@/components/multi-select-actions";
import { Navigation } from "@/components/navigation";
import { useState } from "react";

export default function Dashboard() {
  const [selectedTeams, setSelectedTeams] = useState<Set<string>>(new Set());

  const { data: healthData, isLoading } = useQuery<Record<string, HealthStatus>>({
    queryKey: ["health"],
    queryFn: fetchAllHealth,
  });

  const teamHealth = TEAM_DATA.teams.map((team) => ({
    ...team,
    health: healthData?.[team.subdomain] || { status: "loading", agents: [] },
  }));

  const totalAgents = teamHealth.reduce(
    (sum, t) => sum + (t.health.agents?.length || 0),
    0
  );
  const onlineAgents = teamHealth.reduce(
    (sum, t) =>
      sum + (t.health.agents?.filter((a) => a.status === "online").length || 0),
    0
  );
  const activeTeams = teamHealth.filter((t) => t.health.status === "online").length;

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <Navigation />
      <Header
        onlineAgents={onlineAgents}
        totalAgents={totalAgents}
        activeTeams={activeTeams}
        totalTeams={TEAM_DATA.teams.length}
      />

      {selectedTeams.size > 0 && (
        <MultiSelectActions
          selectedTeams={Array.from(selectedTeams)}
          onClear={() => setSelectedTeams(new Set())}
        />
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {teamHealth.map((team) => (
          <TeamCard
            key={team.subdomain}
            team={team}
            isSelected={selectedTeams.has(team.subdomain)}
            onSelect={(selected) => {
              const newSet = new Set(selectedTeams);
              if (selected) {
                newSet.add(team.subdomain);
              } else {
                newSet.delete(team.subdomain);
              }
              setSelectedTeams(newSet);
            }}
          />
        ))}
      </div>

      {isLoading && (
        <div className="mt-6 text-center text-gray-500">
          Lädt Health-Status...
        </div>
      )}
    </div>
  );
}
