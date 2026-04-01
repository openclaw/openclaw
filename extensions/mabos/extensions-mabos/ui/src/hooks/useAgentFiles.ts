import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useAgentFiles(agentId: string) {
  return useQuery({
    queryKey: ["agent-files", agentId],
    queryFn: () => api.getAgentFiles(agentId),
    enabled: !!agentId,
  });
}

export function useAgentFile(agentId: string, filename: string) {
  return useQuery({
    queryKey: ["agent-file", agentId, filename],
    queryFn: () => api.getAgentFile(agentId, filename),
    enabled: !!agentId && !!filename,
  });
}

export function useUpdateAgentFile(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ filename, content }: { filename: string; content: string }) =>
      api.updateAgentFile(agentId, filename, content),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["agent-file", agentId, variables.filename] });
      queryClient.invalidateQueries({ queryKey: ["agent-files", agentId] });
    },
  });
}
