import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function usePolicies(params?: { status?: string; category?: string }) {
  return useQuery({
    queryKey: ["erp", "compliance", "policies", params],
    queryFn: () => api.getPolicies(params),
  });
}

export function useViolations(params?: { status?: string; severity?: string }) {
  return useQuery({
    queryKey: ["erp", "compliance", "violations", params],
    queryFn: () => api.getViolations(params),
  });
}

export function useViolation(id: string | null) {
  return useQuery({
    queryKey: ["erp", "compliance", "violation", id],
    queryFn: () => api.getViolation(id!),
    enabled: !!id,
  });
}
