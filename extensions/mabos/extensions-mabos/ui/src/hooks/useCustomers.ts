import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useContacts(params?: { segment?: string; lifecycle_stage?: string }) {
  return useQuery({
    queryKey: ["erp", "customers", "contacts", params],
    queryFn: () => api.getContacts(params),
  });
}

export function useContactSearch(q: string) {
  return useQuery({
    queryKey: ["erp", "customers", "search", q],
    queryFn: () => api.searchContacts(q),
    enabled: q.length >= 2,
  });
}

export function useContact(id: string | null) {
  return useQuery({
    queryKey: ["erp", "customers", "contact", id],
    queryFn: () => api.getContact(id!),
    enabled: !!id,
  });
}
