import { useState, useEffect, useCallback } from "react";

type ApprovalRequest = {
  id: string;
  tool: string;
  reason: string;
  riskLevel: string;
  requestedAt: string;
  status: "pending" | "approved" | "denied";
};

type ScanLogEntry = {
  id: string;
  type: string;
  severity: string;
  message: string;
  timestamp: string;
};

type SecurityState = {
  approvals: ApprovalRequest[];
  scanLog: ScanLogEntry[];
  isLoading: boolean;
  error: string | null;
};

export function useSecurity() {
  const [state, setState] = useState<SecurityState>({
    approvals: [],
    scanLog: [],
    isLoading: true,
    error: null,
  });

  const fetchAll = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const [approvalsRes, scanRes] = await Promise.all([
        fetch("/mabos/security/approvals"),
        fetch("/mabos/security/scan-log"),
      ]);

      if (!approvalsRes.ok || !scanRes.ok) {
        throw new Error("Failed to fetch security data");
      }

      const [approvals, scanLog] = await Promise.all([
        approvalsRes.json() as Promise<ApprovalRequest[]>,
        scanRes.json() as Promise<ScanLogEntry[]>,
      ]);

      setState({ approvals, scanLog, isLoading: false, error: null });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: err instanceof Error ? err.message : "Unknown error",
      }));
    }
  }, []);

  const approveRequest = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/mabos/security/approvals/${id}/approve`, {
          method: "POST",
        });
        if (!res.ok) throw new Error("Approve failed");
        await fetchAll();
      } catch (err) {
        setState((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : "Approve failed",
        }));
      }
    },
    [fetchAll],
  );

  const denyRequest = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/mabos/security/approvals/${id}/deny`, {
          method: "POST",
        });
        if (!res.ok) throw new Error("Deny failed");
        await fetchAll();
      } catch (err) {
        setState((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : "Deny failed",
        }));
      }
    },
    [fetchAll],
  );

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  return {
    approvals: state.approvals,
    scanLog: state.scanLog,
    isLoading: state.isLoading,
    error: state.error,
    approveRequest,
    denyRequest,
    refresh: fetchAll,
  };
}
