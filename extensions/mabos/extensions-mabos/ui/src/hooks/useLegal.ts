import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function usePartnershipContracts(params?: { status?: string }) {
  return useQuery({
    queryKey: ["erp", "legal", "partnership-contracts", params],
    queryFn: () => api.getPartnershipContracts(params),
  });
}

export function useFreelancerContracts(params?: { status?: string }) {
  return useQuery({
    queryKey: ["erp", "legal", "freelancer-contracts", params],
    queryFn: () => api.getFreelancerContracts(params),
  });
}

export function useCorporateDocuments(params?: { doc_type?: string }) {
  return useQuery({
    queryKey: ["erp", "legal", "corporate-documents", params],
    queryFn: () => api.getCorporateDocuments(params),
  });
}

export function useLegalStructure() {
  return useQuery({
    queryKey: ["erp", "legal", "structure"],
    queryFn: api.getLegalStructure,
  });
}

export function useComplianceGuardrails(params?: { active?: boolean; category?: string }) {
  return useQuery({
    queryKey: ["erp", "legal", "guardrails", params],
    queryFn: () => api.getComplianceGuardrails(params),
  });
}
