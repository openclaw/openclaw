import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useSuppliers(params?: { status?: string; category?: string }) {
  return useQuery({
    queryKey: ["erp", "suppliers", "list", params],
    queryFn: () => api.getSuppliers(params),
  });
}

export function usePurchaseOrders(params?: { supplier_id?: string; status?: string }) {
  return useQuery({
    queryKey: ["erp", "suppliers", "purchase-orders", params],
    queryFn: () => api.getPurchaseOrders(params),
  });
}

export function useSupplier(id: string | null) {
  return useQuery({
    queryKey: ["erp", "suppliers", "detail", id],
    queryFn: () => api.getSupplier(id!),
    enabled: !!id,
  });
}
