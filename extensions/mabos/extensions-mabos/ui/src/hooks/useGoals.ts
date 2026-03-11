import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useGoals(businessId: string) {
  return useQuery({
    queryKey: ["goals", businessId],
    queryFn: () => api.getGoals(businessId),
    enabled: !!businessId,
  });
}
