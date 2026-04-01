import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useMetrics(businessId: string) {
  return useQuery({
    queryKey: ["metrics", businessId],
    queryFn: () => api.getMetrics(businessId),
    enabled: !!businessId,
    refetchInterval: 60_000,
  });
}
