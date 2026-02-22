"use client";

import { Users, Zap, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { AgentTeam } from "@/lib/agent-registry";

interface TeamTemplatesSectionProps {
  teams: AgentTeam[];
  onSpawnTeam: (team: AgentTeam) => void;
  isSpawning?: string | null;
}

export function TeamTemplatesSection({ 
  teams, 
  onSpawnTeam, 
  isSpawning 
}: TeamTemplatesSectionProps) {
  if (teams.length === 0) {return null;}

  return (
    <section className="mb-10 px-1" aria-labelledby="team-templates-title">
      <div className="flex items-center justify-between mb-4">
        <h2 
          id="team-templates-title"
          className="text-lg font-semibold flex items-center gap-2"
        >
          <Users className="w-5 h-5 text-indigo-500" />
          Specialized Team Templates
        </h2>
        <Badge variant="outline" className="text-[10px] uppercase font-bold tracking-wider opacity-70">
          Solo Founder Ready
        </Badge>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {teams.map((team) => (
          <Card 
            key={team.id} 
            className="p-5 flex flex-col justify-between border-indigo-500/20 bg-indigo-500/5 hover:border-indigo-500/40 transition-colors"
          >
            <div>
              <div className="flex items-start justify-between gap-4 mb-2">
                <h3 className="font-bold text-base leading-tight">{team.name}</h3>
                <Zap className="w-4 h-4 text-indigo-500 shrink-0" />
              </div>
              <p className="text-sm text-muted-foreground mb-4 min-h-[40px]">
                {team.description}
              </p>
              
              <div className="flex flex-wrap gap-1.5 mb-6">
                {team.agentIds.map((id) => (
                  <Badge 
                    key={id} 
                    variant="secondary" 
                    className="text-[10px] bg-background/50 border-none"
                  >
                    {id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')}
                  </Badge>
                ))}
              </div>
            </div>

            <Button 
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white gap-2"
              onClick={() => onSpawnTeam(team)}
              disabled={isSpawning === team.id}
            >
              {isSpawning === team.id ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Spawning Team...
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  Deploy Team
                </>
              )}
            </Button>
          </Card>
        ))}
      </div>
    </section>
  );
}
