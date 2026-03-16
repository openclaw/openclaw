import type { AcpGatewayTerminalResult } from "../store/terminal-resolution.js";

export type FakeAcpNodeWorkerTransport = (params: {
  event: "acp.worker.event" | "acp.worker.heartbeat" | "acp.worker.terminal";
  nodeId: string;
  payload: Record<string, unknown>;
}) => Promise<void>;

export type FakeAcpNodeWorkerStep =
  | {
      kind: "event";
      seq: number;
      eventId: string;
      event: Record<string, unknown>;
    }
  | {
      kind: "terminal";
      finalSeq: number;
      terminalEventId: string;
      result: AcpGatewayTerminalResult;
    }
  | {
      kind: "heartbeat";
    };

export class FakeAcpNodeWorker {
  constructor(
    private readonly transport: FakeAcpNodeWorkerTransport,
    private readonly session: {
      sessionKey: string;
      runId: string;
      nodeId: string;
      leaseId: string;
      leaseEpoch: number;
    },
  ) {}

  async run(steps: FakeAcpNodeWorkerStep[]): Promise<void> {
    for (const step of steps) {
      if (step.kind === "event") {
        await this.transport({
          event: "acp.worker.event",
          nodeId: this.session.nodeId,
          payload: {
            ...this.session,
            seq: step.seq,
            eventId: step.eventId,
            event: step.event,
          },
        });
        continue;
      }
      if (step.kind === "terminal") {
        await this.transport({
          event: "acp.worker.terminal",
          nodeId: this.session.nodeId,
          payload: {
            ...this.session,
            finalSeq: step.finalSeq,
            terminalEventId: step.terminalEventId,
            result: step.result,
          },
        });
        continue;
      }
      await this.transport({
        event: "acp.worker.heartbeat",
        nodeId: this.session.nodeId,
        payload: {
          ...this.session,
        },
      });
    }
  }
}
