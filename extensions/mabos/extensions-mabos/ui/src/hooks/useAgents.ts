import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useAgents(businessId: string) {
  return useQuery({
    queryKey: ["agents", businessId],
    queryFn: () => api.getAgents(businessId),
    enabled: !!businessId,
    refetchInterval: 30_000,
  });
}
