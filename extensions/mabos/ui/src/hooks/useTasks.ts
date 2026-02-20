import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useTasks(businessId: string) {
  return useQuery({
    queryKey: ["tasks", businessId],
    queryFn: () => api.getTasks(businessId),
    enabled: !!businessId,
  });
}
