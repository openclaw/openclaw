import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Contractor } from "@/lib/types";

export function useContractors() {
  return useQuery<{ contractors: Contractor[] }>({
    queryKey: ["contractors"],
    queryFn: () => api.getContractors(),
  });
}
