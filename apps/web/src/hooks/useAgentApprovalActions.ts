import * as React from "react";
import { useOptionalGateway } from "@/providers/GatewayProvider";
import { useAgentStore } from "@/stores/useAgentStore";
import { showError, showSuccess, showWarning } from "@/lib/toast";

export function useAgentApprovalActions() {
  const gatewayCtx = useOptionalGateway();
  const updateAgentWith = useAgentStore((s) => s.updateAgentWith);

  const approvePending = React.useCallback(
    async (agentId: string) => {
      const agent = useAgentStore.getState().agents.find((entry) => entry.id === agentId);
      const pending = agent?.pendingToolCallIds ?? [];
      if (!pending.length) {
        showWarning("No pending approvals for this agent.");
        return false;
      }
      if (!gatewayCtx?.isConnected) {
        showWarning("Gateway not connected — approval stubbed.");
        return false;
      }

      try {
        await Promise.all(
          pending.map((toolCallId) =>
            gatewayCtx.client.request("tool.approve", { toolCallId })
          )
        );
        updateAgentWith(agentId, (entry) => ({
          ...entry,
          pendingToolCallIds: [],
          pendingApprovals: 0,
        }));
        showSuccess(`Approved ${pending.length} request${pending.length === 1 ? "" : "s"} for ${agent?.name ?? "agent"}.`);
        return true;
      } catch (error) {
        console.error("Failed to approve pending tool calls:", error);
        showError("Failed to approve. The request may have expired in the external system; ask the agent to retry.");
        return false;
      }
    },
    [gatewayCtx, updateAgentWith]
  );

  const denyPending = React.useCallback(
    async (agentId: string) => {
      const agent = useAgentStore.getState().agents.find((entry) => entry.id === agentId);
      const pending = agent?.pendingToolCallIds ?? [];
      if (!pending.length) {
        showWarning("No pending approvals for this agent.");
        return false;
      }
      if (!gatewayCtx?.isConnected) {
        showWarning("Gateway not connected — denial stubbed.");
        return false;
      }

      try {
        await Promise.all(
          pending.map((toolCallId) =>
            gatewayCtx.client.request("tool.reject", { toolCallId, reason: "Denied by operator" })
          )
        );
        updateAgentWith(agentId, (entry) => ({
          ...entry,
          pendingToolCallIds: [],
          pendingApprovals: 0,
        }));
        showSuccess(`Denied ${pending.length} request${pending.length === 1 ? "" : "s"} for ${agent?.name ?? "agent"}.`);
        return true;
      } catch (error) {
        console.error("Failed to deny pending tool calls:", error);
        showError("Failed to deny. The request may have expired or the gateway may have dropped it; ask the agent to retry.");
        return false;
      }
    },
    [gatewayCtx, updateAgentWith]
  );

  return { approvePending, denyPending };
}

export default useAgentApprovalActions;
