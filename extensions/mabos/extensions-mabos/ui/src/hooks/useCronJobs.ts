/**
 * React Query hooks for cron job management.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { CronJob } from "@/lib/types";

export function useCronJobs(businessId: string) {
  return useQuery({
    queryKey: ["cronJobs", businessId],
    queryFn: () => api.getCronJobs(businessId),
    select: (data) => data.jobs,
  });
}

export function useCronJobsByWorkflow(businessId: string, workflowId: string) {
  return useQuery({
    queryKey: ["cronJobs", businessId, "workflow", workflowId],
    queryFn: () => api.getCronJobsByWorkflow(businessId, workflowId),
    select: (data) => data.jobs,
    enabled: !!workflowId,
  });
}

export function useToggleCronJob(businessId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ jobId, enabled }: { jobId: string; enabled: boolean }) =>
      api.updateCronJob(businessId, jobId, { enabled } as Partial<CronJob>),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cronJobs", businessId] });
    },
  });
}
