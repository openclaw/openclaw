import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { TroposGoalModel } from "@/lib/types";

export function useGoalModel(businessId: string) {
  return useQuery({
    queryKey: ["goals", businessId],
    queryFn: () => api.getGoals(businessId),
  });
}

export function useUpdateGoalModel(businessId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (goalModel: TroposGoalModel) => api.updateGoals(businessId, goalModel),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["goals", businessId] });
    },
  });
}
