import type { NodeEvent } from "../../gateway/server-node-events-types.js";
import { getAcpGatewayNodeRuntime } from "../store/gateway-events.js";
import type { AcpGatewayRecoveryReason } from "../store/types.js";

export type FakeAcpNodeWorkerStep =
  | {
      kind: "event";
      event: NodeEvent["event"];
      payload: unknown;
    }
  | {
      kind: "disconnect";
      reason: AcpGatewayRecoveryReason;
      now?: number;
    }
  | {
      kind: "reconcile";
      sessionKey: string;
      leaseId: string;
      leaseEpoch: number;
      now?: number;
      nodeRuntimeSessionId?: string;
      nodeWorkerRunId?: string;
      workerProtocolVersion?: number;
    };

export class FakeAcpNodeWorker {
  readonly sentEvents: Array<{ event: string; payload: unknown }> = [];

  constructor(readonly nodeId: string) {}

  async play(steps: FakeAcpNodeWorkerStep[]): Promise<void> {
    for (const step of steps) {
      if (step.kind === "event") {
        this.sentEvents.push({ event: step.event, payload: step.payload });
        await getAcpGatewayNodeRuntime().ingestNodeEvent(this.nodeId, {
          event: step.event,
          payloadJSON: JSON.stringify(step.payload),
        });
        continue;
      }
      if (step.kind === "reconcile") {
        await getAcpGatewayNodeRuntime().reconcileSuspectLease({
          sessionKey: step.sessionKey,
          nodeId: this.nodeId,
          leaseId: step.leaseId,
          leaseEpoch: step.leaseEpoch,
          ...(typeof step.now === "number" ? { now: step.now } : {}),
          ...(step.nodeRuntimeSessionId ? { nodeRuntimeSessionId: step.nodeRuntimeSessionId } : {}),
          ...(step.nodeWorkerRunId ? { nodeWorkerRunId: step.nodeWorkerRunId } : {}),
          ...(typeof step.workerProtocolVersion === "number"
            ? { workerProtocolVersion: step.workerProtocolVersion }
            : {}),
        });
        continue;
      }
      await getAcpGatewayNodeRuntime().markNodeDisconnected({
        nodeId: this.nodeId,
        reason: step.reason,
        ...(typeof step.now === "number" ? { now: step.now } : {}),
      });
    }
  }
}
