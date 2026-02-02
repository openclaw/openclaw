import * as React from "react";
import { useOptionalGateway } from "@/providers/GatewayProvider";
import type { GatewayEvent } from "@/lib/api";
import { useAgentStore } from "@/stores/useAgentStore";

// Event payload types for tool and agent events
interface ToolCallEventPayload {
  toolCallId?: string;
  toolName?: string;
  agentId?: string;
  args?: Record<string, unknown>;
  risk?: "low" | "medium" | "high";
  reason?: string;
  modifiedArgs?: unknown;
}

interface AgentThinkingPayload {
  agentId?: string;
  thought?: string;
}

interface WorkflowWaitingPayload {
  agentId?: string;
  pendingTools?: string[];
}

function getAgentIdFromPayload(payload: unknown): string | undefined {
  if (payload && typeof payload === "object" && "agentId" in payload) {
    return (payload as { agentId?: string }).agentId;
  }
  return undefined;
}

function buildPendingTaskLabel(toolName?: string) {
  if (!toolName) return "Awaiting approval";
  return `Approve ${toolName.replace(/_/g, " ")} access`;
}

export function useAgentLiveUpdates() {
  const gatewayCtx = useOptionalGateway();
  const upsertAgent = useAgentStore((s) => s.upsertAgent);
  const updateAgentWith = useAgentStore((s) => s.updateAgentWith);

  React.useEffect(() => {
    if (!gatewayCtx) return;

    const ensureAgent = (agentId: string) => {
      const existing = useAgentStore.getState().agents.find((agent) => agent.id === agentId);
      if (existing) return;
      upsertAgent({
        id: agentId,
        name: agentId,
        role: "Agent",
        status: "paused",
      });
    };

    const applyPending = (agentId: string, data?: ToolCallEventPayload) => {
      ensureAgent(agentId);
      updateAgentWith(agentId, (agent) => {
        const pendingIds = new Set(agent.pendingToolCallIds ?? []);
        if (data?.toolCallId) pendingIds.add(data.toolCallId);
        const nextIds = Array.from(pendingIds);
        return {
          ...agent,
          status: "paused",
          currentTask: buildPendingTaskLabel(data?.toolName),
          pendingToolCallIds: nextIds,
          pendingApprovals: nextIds.length,
        };
      });
    };

    const clearPending = (agentId: string, toolCallId?: string) => {
      updateAgentWith(agentId, (agent) => {
        const pendingIds = new Set(agent.pendingToolCallIds ?? []);
        if (toolCallId) pendingIds.delete(toolCallId);
        const nextIds = Array.from(pendingIds);
        return {
          ...agent,
          pendingToolCallIds: nextIds,
          pendingApprovals: nextIds.length,
        };
      });
    };

    const handleEvent = (event: GatewayEvent) => {
      const payload = event.payload as ToolCallEventPayload | AgentThinkingPayload | WorkflowWaitingPayload | undefined;
      const agentId = getAgentIdFromPayload(payload);

      switch (event.event) {
        case "tool.pending": {
          if (!agentId) return;
          applyPending(agentId, payload as ToolCallEventPayload);
          break;
        }

        case "tool.approved": {
          if (!agentId) return;
          clearPending(agentId, (payload as ToolCallEventPayload)?.toolCallId);
          break;
        }

        case "tool.rejected": {
          if (!agentId) return;
          clearPending(agentId, (payload as ToolCallEventPayload)?.toolCallId);
          break;
        }

        case "workflow.waiting_approval": {
          if (!agentId) return;
          ensureAgent(agentId);
          updateAgentWith(agentId, (agent) => ({
            ...agent,
            status: "paused",
            currentTask: agent.currentTask ?? "Awaiting approval",
          }));
          break;
        }

        case "agent.thinking": {
          if (!agentId) return;
          ensureAgent(agentId);
          const thinkingPayload = payload as AgentThinkingPayload;
          updateAgentWith(agentId, (agent) => ({
            ...agent,
            status: "busy",
            currentTask: thinkingPayload?.thought ?? agent.currentTask,
          }));
          break;
        }
      }
    };

    return gatewayCtx.addEventListener(handleEvent);
  }, [gatewayCtx, upsertAgent, updateAgentWith]);
}

export default useAgentLiveUpdates;
