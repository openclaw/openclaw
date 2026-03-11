import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { AgentListItem } from "@/lib/types";

export function useCreateAgent(businessId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: {
      id: string;
      name: string;
      type: "core" | "domain";
      autonomy_level: "low" | "medium" | "high";
      approval_threshold_usd: number;
    }) => api.createAgent(businessId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents", businessId] });
    },
  });
}

export function useUpdateAgent(businessId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ agentId, body }: { agentId: string; body: Partial<AgentListItem> }) =>
      api.updateAgent(businessId, agentId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents", businessId] });
    },
  });
}

export function useArchiveAgent(businessId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (agentId: string) => api.archiveAgent(businessId, agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents", businessId] });
    },
  });
}
