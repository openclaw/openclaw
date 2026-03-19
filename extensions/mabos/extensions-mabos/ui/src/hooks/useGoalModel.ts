import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { TroposGoalModel } from "@/lib/types";

export function useGoalModel(businessId: string | undefined) {
  return useQuery({
    queryKey: ["goals", businessId],
    queryFn: () => {
      if (!businessId) throw new Error("Missing business ID");
      return api.getGoals(businessId);
    },
    enabled: !!businessId,
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
