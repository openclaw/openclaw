/**
 * React Query hooks for cron job management.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { CronJob } from "@/lib/types";

export function useCronJobs(businessId: string | undefined) {
  return useQuery({
    queryKey: ["cronJobs", businessId],
    queryFn: () => {
      if (!businessId) throw new Error("Missing business ID");
      return api.getCronJobs(businessId);
    },
    select: (data) => data.jobs,
    enabled: !!businessId,
  });
}

export function useCronJobsByWorkflow(businessId: string | undefined, workflowId: string) {
  return useQuery({
    queryKey: ["cronJobs", businessId, "workflow", workflowId],
    queryFn: () => {
      if (!businessId) throw new Error("Missing business ID");
      return api.getCronJobsByWorkflow(businessId, workflowId);
    },
    select: (data) => data.jobs,
    enabled: !!businessId && !!workflowId,
  });
}

export function useToggleCronJob(businessId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ jobId, enabled }: { jobId: string; enabled: boolean }) => {
      if (!businessId) throw new Error("Missing business ID");
      return api.updateCronJob(businessId, jobId, { enabled } as Partial<CronJob>);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cronJobs", businessId] });
    },
  });
}
