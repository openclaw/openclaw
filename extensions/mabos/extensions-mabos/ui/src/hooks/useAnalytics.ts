import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useReports(params?: { type?: string; status?: string }) {
  return useQuery({
    queryKey: ["erp", "analytics", "reports", params],
    queryFn: () => api.getReports(params),
  });
}

export function useReportSnapshots(reportId: string) {
  return useQuery({
    queryKey: ["erp", "analytics", "snapshots", reportId],
    queryFn: () => api.getReportSnapshots(reportId),
    enabled: !!reportId,
  });
}

export function useDashboards(params?: { owner_id?: string }) {
  return useQuery({
    queryKey: ["erp", "analytics", "dashboards", params],
    queryFn: () => api.getDashboards(params),
  });
}

export function useRunReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.runReport(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["erp", "analytics"] });
    },
  });
}
