import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useProducts(params?: { category?: string; status?: string }) {
  return useQuery({
    queryKey: ["erp", "ecommerce", "products", params],
    queryFn: () => api.getProducts(params),
  });
}

export function useOrders(params?: { status?: string }) {
  return useQuery({
    queryKey: ["erp", "ecommerce", "orders", params],
    queryFn: () => api.getOrders(params),
  });
}

export function useOrder(id: string | null) {
  return useQuery({
    queryKey: ["erp", "ecommerce", "order", id],
    queryFn: () => api.getOrder(id!),
    enabled: !!id,
  });
}

export function useUpdateOrderStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.updateOrderStatus(id, status),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["erp", "ecommerce", "orders"] });
    },
  });
}
