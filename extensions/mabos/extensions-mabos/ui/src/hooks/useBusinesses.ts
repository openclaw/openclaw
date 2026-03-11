import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useBusinesses() {
  return useQuery({
    queryKey: ["businesses"],
    queryFn: api.getBusinesses,
  });
}
