import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useCampaigns(params?: { status?: string; type?: string }) {
  return useQuery({
    queryKey: ["erp", "marketing", "campaigns", params],
    queryFn: () => api.getMarketingCampaigns(params),
  });
}

export function useCampaignMetrics(id: string | null) {
  return useQuery({
    queryKey: ["erp", "marketing", "metrics", id],
    queryFn: () => api.getCampaignMetrics(id!),
    enabled: !!id,
  });
}

export function useMarketingKpis() {
  return useQuery({
    queryKey: ["erp", "marketing", "kpis"],
    queryFn: api.getMarketingKpis,
  });
}
