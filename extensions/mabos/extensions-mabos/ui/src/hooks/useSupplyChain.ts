import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useShipments(params?: { status?: string }) {
  return useQuery({
    queryKey: ["erp", "supply-chain", "shipments", params],
    queryFn: () => api.getShipments(params),
  });
}

export function useShipment(id: string | null) {
  return useQuery({
    queryKey: ["erp", "supply-chain", "shipment", id],
    queryFn: () => api.getShipment(id!),
    enabled: !!id,
  });
}

export function useRoutes(params?: { status?: string }) {
  return useQuery({
    queryKey: ["erp", "supply-chain", "routes", params],
    queryFn: () => api.getRoutes(params),
  });
}
