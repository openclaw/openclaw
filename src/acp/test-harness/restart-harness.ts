import type {
  AcpDispatchDeliveryCoordinator,
  AcpDispatchDeliveryMeta,
} from "../../auto-reply/reply/dispatch-acp-delivery.js";
import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { AcpGatewayRunDeliveryTargetRecord } from "../store/types.js";

export type RecordedProjectionDelivery = {
  instanceId: number;
  targetKey: string;
  restartMode: boolean;
  kind: ReplyDispatchKind;
  payload: ReplyPayload;
  meta?: AcpDispatchDeliveryMeta;
};

let nextGlobalProjectionInstanceId = 1;

export function createProjectionRestartHarness() {
  const deliveries: RecordedProjectionDelivery[] = [];
  const createdInstanceIds: number[] = [];

  const createCoordinatorFactory = () => {
    return (params: {
      target: AcpGatewayRunDeliveryTargetRecord;
      restartMode: boolean;
    }): AcpDispatchDeliveryCoordinator => {
      const instanceId = nextGlobalProjectionInstanceId++;
      createdInstanceIds.push(instanceId);
      return {
        startReplyLifecycle: async () => {},
        deliver: async (kind, payload, meta) => {
          deliveries.push({
            instanceId,
            targetKey: params.target.targetKey,
            restartMode: params.restartMode,
            kind,
            payload,
            ...(meta ? { meta } : {}),
          });
          return true;
        },
        getBlockCount: () => 0,
        getAccumulatedBlockText: () => "",
        resolveSyntheticFinalPayload: async () => null,
        hasDeliveredSyntheticFinal: () => false,
        markSyntheticFinalDelivered: () => {},
        getRoutedCounts: () => ({ tool: 0, block: 0, final: 0 }),
        applyRoutedCounts: () => {},
      };
    };
  };

  return {
    deliveries,
    createdInstanceIds,
    createCoordinatorFactory,
  };
}
