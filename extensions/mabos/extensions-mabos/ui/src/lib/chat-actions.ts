import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { usePanels } from "@/contexts/PanelContext";
import { api } from "@/lib/api";
import type { ChatAction, EntityType } from "@/lib/types";

const mutationMap: Record<string, (data: Record<string, unknown>) => Promise<unknown>> = {
  resolveDecision: (data) =>
    api.resolveDecision(String(data.id), {
      optionId: String(data.optionId),
      feedback: data.feedback as string | undefined,
      action: data.action as "approve" | "reject" | "defer",
    }),
  updateTask: (data) => api.updateTask(String(data.businessId), String(data.taskId), data.body),
  updateGoals: (data) => api.updateGoals(String(data.businessId), data.goalModel as any),
  triggerBdiCycle: (data) => api.triggerBdiCycle(String(data.businessId), String(data.agentId)),
  createAgent: (data) => api.createAgent(String(data.businessId), data.agent as any),
};

export function useChatActionDispatcher() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { openDetailPanel } = usePanels();

  const dispatchAction = useCallback(
    async (action: ChatAction) => {
      switch (action.type) {
        case "invalidate_query": {
          const keys = action.payload.queryKeys || [];
          for (const key of keys) {
            await queryClient.invalidateQueries({ queryKey: key });
          }
          break;
        }
        case "mutate_data": {
          const fn = action.payload.mutationFn;
          const data = action.payload.mutationData || {};
          if (fn && mutationMap[fn]) {
            await mutationMap[fn](data);
          }
          break;
        }
        case "navigate": {
          if (action.payload.route) {
            navigate({ to: action.payload.route });
          }
          break;
        }
        case "open_detail": {
          if (action.payload.entityType && action.payload.entityId) {
            openDetailPanel(
              action.payload.entityType as EntityType,
              action.payload.entityId,
              action.payload.entityData,
            );
          }
          break;
        }
      }
    },
    [queryClient, navigate, openDetailPanel],
  );

  return { dispatchAction };
}
