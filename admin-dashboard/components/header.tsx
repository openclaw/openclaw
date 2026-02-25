import { Badge } from "@/components/ui/badge";

interface HeaderProps {
  onlineAgents: number;
  totalAgents: number;
  activeTeams: number;
  totalTeams: number;
}

export function Header({ onlineAgents, totalAgents, activeTeams, totalTeams }: HeaderProps) {
  return (
    <div className="mb-6">
      <h1 className="text-3xl font-bold text-gray-900">Activi Admin Dashboard</h1>
      <div className="mt-4 flex flex-wrap gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-600">Agenten:</span>
          <Badge variant={onlineAgents === totalAgents ? "default" : "secondary"}>
            {onlineAgents}/{totalAgents} online
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-600">Teams:</span>
          <Badge variant={activeTeams === totalTeams ? "default" : "secondary"}>
            {activeTeams}/{totalTeams} aktiv
          </Badge>
        </div>
      </div>
    </div>
  );
}
