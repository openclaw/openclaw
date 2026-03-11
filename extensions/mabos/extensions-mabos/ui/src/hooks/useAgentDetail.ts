import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useAgentDetail(agentId: string) {
  return useQuery({
    queryKey: ["agent-detail", agentId],
    queryFn: () => api.getAgentDetail(agentId),
    enabled: !!agentId,
  });
}
