import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useStockItems(params?: { status?: string }) {
  return useQuery({
    queryKey: ["erp", "inventory", "items", params],
    queryFn: () => api.getStockItems(params),
  });
}

export function useLowStockAlerts() {
  return useQuery({
    queryKey: ["erp", "inventory", "alerts"],
    queryFn: api.getLowStockAlerts,
  });
}

export function useStockMovements(itemId: string | null) {
  return useQuery({
    queryKey: ["erp", "inventory", "movements", itemId],
    queryFn: () => api.getStockMovements(itemId!),
    enabled: !!itemId,
  });
}
