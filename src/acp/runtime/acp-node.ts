import type { NodeSession } from "../../gateway/node-registry.js";
import { AcpGatewayNodeRuntime, type AcpGatewayNodeInvoker } from "../store/gateway-events.js";
import type { AcpGatewayNodeSessionStatus } from "../store/gateway-events.js";
import { AcpRuntimeError } from "./errors.js";
import { registerAcpRuntimeBackend } from "./registry.js";
import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurnInput,
} from "./types.js";

export const ACP_NODE_BACKEND_ID = "acp-node";
const ACP_NODE_HANDLE_PREFIX = "acp-node:v1:";
const ACP_NODE_REQUIRED_COMMANDS = [
  "acp.session.ensure",
  "acp.session.load",
  "acp.turn.start",
  "acp.turn.cancel",
  "acp.session.close",
  "acp.session.status",
] as const;

type AcpNodeHandleState = {
  sessionKey: string;
  nodeId: string;
  leaseId: string;
  leaseEpoch: number;
};

type AcpNodeRuntimeParams = {
  gatewayRuntime?: AcpGatewayNodeRuntime;
  invokeNode: AcpGatewayNodeInvoker;
  listNodes: () => NodeSession[];
  pollIntervalMs?: number;
};

type AcpNodeInvokePayload = {
  ok?: boolean;
  accepted?: boolean;
  nodeRuntimeSessionId?: string;
  nodeWorkerRunId?: string;
  message?: string;
};

const RECOVERABLE_START_ERROR_CODES = new Set(["TIMEOUT", "UNAVAILABLE"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeHandleState(state: AcpNodeHandleState): string {
  return `${ACP_NODE_HANDLE_PREFIX}${Buffer.from(JSON.stringify(state), "utf8").toString("base64url")}`;
}

function decodeHandleState(handle: AcpRuntimeHandle): AcpNodeHandleState {
  const raw = handle.runtimeSessionName.trim();
  if (!raw.startsWith(ACP_NODE_HANDLE_PREFIX)) {
    throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "Invalid acp-node runtime handle.");
  }
  const encoded = raw.slice(ACP_NODE_HANDLE_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  } catch (error) {
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      "Could not decode acp-node runtime handle.",
      {
        cause: error,
      },
    );
  }
  if (!isRecord(parsed)) {
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      "Decoded acp-node runtime handle is invalid.",
    );
  }
  const sessionKey =
    typeof parsed.sessionKey === "string" && parsed.sessionKey.trim()
      ? parsed.sessionKey.trim()
      : "";
  const nodeId =
    typeof parsed.nodeId === "string" && parsed.nodeId.trim() ? parsed.nodeId.trim() : "";
  const leaseId =
    typeof parsed.leaseId === "string" && parsed.leaseId.trim() ? parsed.leaseId.trim() : "";
  const leaseEpoch =
    typeof parsed.leaseEpoch === "number" && Number.isFinite(parsed.leaseEpoch)
      ? Math.trunc(parsed.leaseEpoch)
      : 0;
  if (!sessionKey || !nodeId || !leaseId || leaseEpoch <= 0) {
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      "Decoded acp-node runtime handle is missing required state.",
    );
  }
  return {
    sessionKey,
    nodeId,
    leaseId,
    leaseEpoch,
  };
}

function parseInvokePayload(result: {
  payload?: unknown;
  payloadJSON?: string | null;
}): Record<string, unknown> {
  const source =
    typeof result.payloadJSON === "string"
      ? (() => {
          try {
            return JSON.parse(result.payloadJSON) as unknown;
          } catch (error) {
            throw new AcpRuntimeError(
              "ACP_TURN_FAILED",
              "ACP node returned invalid JSON payload.",
              {
                cause: error,
              },
            );
          }
        })()
      : result.payload;
  if (!isRecord(source)) {
    throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP node returned an invalid payload.");
  }
  return source;
}

function toRuntimeError(
  error: unknown,
  code: "ACP_SESSION_INIT_FAILED" | "ACP_TURN_FAILED",
): AcpRuntimeError {
  if (error instanceof AcpRuntimeError) {
    return error;
  }
  if (error instanceof Error) {
    return new AcpRuntimeError(code, error.message, {
      cause: error,
    });
  }
  return new AcpRuntimeError(code, "ACP node operation failed.", {
    cause: error,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeErrorCode(code: unknown): string {
  return typeof code === "string" ? code.trim().toUpperCase() : "";
}

function supportsAcpNode(session: NodeSession): boolean {
  const caps = new Set(session.caps ?? []);
  const commands = new Set(session.commands ?? []);
  return caps.has("acp:v1") && ACP_NODE_REQUIRED_COMMANDS.every((command) => commands.has(command));
}

function selectUsableNode(nodes: NodeSession[], preferredNodeId?: string): NodeSession | null {
  if (preferredNodeId) {
    const preferred = nodes.find((node) => node.nodeId === preferredNodeId);
    if (preferred && supportsAcpNode(preferred)) {
      return preferred;
    }
  }
  return nodes.find((node) => supportsAcpNode(node)) ?? null;
}

export class AcpNodeRuntime implements AcpRuntime {
  private readonly gatewayRuntime: AcpGatewayNodeRuntime;
  private readonly invokeNode: AcpGatewayNodeInvoker;
  private readonly listNodes: () => NodeSession[];
  private readonly pollIntervalMs: number;

  constructor(params: AcpNodeRuntimeParams) {
    this.gatewayRuntime = params.gatewayRuntime ?? new AcpGatewayNodeRuntime();
    this.invokeNode = params.invokeNode;
    this.listNodes = params.listNodes;
    this.pollIntervalMs = params.pollIntervalMs ?? 25;
  }

  async ensureSession(input: {
    sessionKey: string;
    agent: string;
    mode: "persistent" | "oneshot";
    resumeSessionId?: string;
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<AcpRuntimeHandle> {
    await this.gatewayRuntime.store.ensureSession({
      sessionKey: input.sessionKey,
    });
    const existingLease = await this.gatewayRuntime.store.getActiveLease(input.sessionKey);
    const selectedNode = selectUsableNode(this.listNodes(), existingLease?.nodeId);
    if (!selectedNode) {
      throw new AcpRuntimeError(
        "ACP_BACKEND_UNAVAILABLE",
        "No connected ACP-capable node is available for the acp-node backend.",
      );
    }
    const lease = await this.resolveLeaseForEnsure({
      sessionKey: input.sessionKey,
      selectedNodeId: selectedNode.nodeId,
      existingLease,
    });
    const result = await this.gatewayRuntime.ensureSession({
      invokeNode: this.invokeNode,
      nodeId: selectedNode.nodeId,
      sessionKey: input.sessionKey,
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      agent: input.agent,
      mode: input.mode,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.resumeSessionId
        ? { resume: { kind: "gateway-reconstruct", runtimeSessionId: input.resumeSessionId } }
        : {}),
      idempotencyKey: `acp-node:ensure:${input.sessionKey}:${lease.leaseId}:${lease.leaseEpoch}`,
    });
    if (!result.ok) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        result.error?.message ?? "ACP node session ensure failed.",
      );
    }
    const payload = parseInvokePayload(result) as AcpNodeInvokePayload;
    return {
      sessionKey: input.sessionKey,
      backend: ACP_NODE_BACKEND_ID,
      runtimeSessionName: encodeHandleState({
        sessionKey: input.sessionKey,
        nodeId: selectedNode.nodeId,
        leaseId: lease.leaseId,
        leaseEpoch: lease.leaseEpoch,
      }),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(typeof payload.nodeRuntimeSessionId === "string" && payload.nodeRuntimeSessionId.trim()
        ? { backendSessionId: payload.nodeRuntimeSessionId.trim() }
        : {}),
    };
  }

  async *runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent> {
    const state = decodeHandleState(input.handle);
    const runId = input.requestId;
    await this.gatewayRuntime.store.startRun({
      sessionKey: state.sessionKey,
      runId,
      requestId: input.requestId,
    });
    let startRecoveredFromUnknownError = false;
    try {
      const started = await this.gatewayRuntime.startTurn({
        invokeNode: this.invokeNode,
        nodeId: state.nodeId,
        sessionKey: state.sessionKey,
        runId,
        leaseId: state.leaseId,
        leaseEpoch: state.leaseEpoch,
        requestId: input.requestId,
        mode: input.mode,
        text: input.text,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        idempotencyKey: `acp-node:turn:${state.sessionKey}:${input.requestId}`,
      });
      if (!started.ok) {
        const errorCode = normalizeErrorCode(started.error?.code);
        if (RECOVERABLE_START_ERROR_CODES.has(errorCode) || !errorCode) {
          await this.recordUnknownStartOutcome({
            state,
            runId,
          });
          startRecoveredFromUnknownError = true;
        } else {
          throw new AcpRuntimeError(
            "ACP_TURN_FAILED",
            started.error?.message ?? "ACP turn start failed.",
          );
        }
      } else {
        const payload = parseInvokePayload(started) as AcpNodeInvokePayload;
        if (payload.accepted !== true) {
          throw new AcpRuntimeError(
            "ACP_TURN_FAILED",
            payload.message ?? "ACP turn was not accepted.",
          );
        }
      }
    } catch (error) {
      const runtimeError = toRuntimeError(error, "ACP_TURN_FAILED");
      await this.recordRejectedStart({
        state,
        runId,
        message: runtimeError.message,
      });
      throw runtimeError;
    }

    let nextSeq = 1;
    let cancelRequested = false;
    for (;;) {
      const delivery = await this.gatewayRuntime.store.getRunDeliveryState({
        runId,
        afterSeq: nextSeq - 1,
      });
      for (const event of delivery.events) {
        nextSeq = event.seq + 1;
        yield event.event;
        await this.gatewayRuntime.store.recordCheckpoint({
          checkpointKey: `runtime:${runId}`,
          sessionKey: state.sessionKey,
          runId,
          cursorSeq: event.seq,
        });
      }
      if (delivery.run?.terminal) {
        if (delivery.run.terminal.kind === "failed") {
          yield {
            type: "error",
            message: delivery.run.terminal.errorMessage ?? "ACP node turn failed.",
            ...(delivery.run.terminal.errorCode ? { code: delivery.run.terminal.errorCode } : {}),
          };
          return;
        }
        yield {
          type: "done",
          ...(delivery.run.terminal.stopReason
            ? { stopReason: delivery.run.terminal.stopReason }
            : {}),
        };
        return;
      }
      if (delivery.run?.state === "cancelling" || delivery.run?.cancelRequestedAt) {
        cancelRequested = true;
      }
      if (startRecoveredFromUnknownError && delivery.run?.state !== "recovering") {
        startRecoveredFromUnknownError = false;
      }
      if (input.signal?.aborted && !cancelRequested) {
        const latestDelivery = await this.gatewayRuntime.store.getRunDeliveryState({
          runId,
          afterSeq: nextSeq - 1,
        });
        for (const event of latestDelivery.events) {
          nextSeq = event.seq + 1;
          yield event.event;
          await this.gatewayRuntime.store.recordCheckpoint({
            checkpointKey: `runtime:${runId}`,
            sessionKey: state.sessionKey,
            runId,
            cursorSeq: event.seq,
          });
        }
        if (latestDelivery.run?.terminal) {
          if (latestDelivery.run.terminal.kind === "failed") {
            yield {
              type: "error",
              message: latestDelivery.run.terminal.errorMessage ?? "ACP node turn failed.",
              ...(latestDelivery.run.terminal.errorCode
                ? { code: latestDelivery.run.terminal.errorCode }
                : {}),
            };
            return;
          }
          yield {
            type: "done",
            ...(latestDelivery.run.terminal.stopReason
              ? { stopReason: latestDelivery.run.terminal.stopReason }
              : {}),
          };
          return;
        }
        if (latestDelivery.run?.state === "cancelling" || latestDelivery.run?.cancelRequestedAt) {
          cancelRequested = true;
          continue;
        }
        await this.requestCancel({
          state,
          runId,
          reason: "signal-aborted",
        });
        cancelRequested = true;
        continue;
      }
      await sleep(this.pollIntervalMs);
    }
  }

  getCapabilities(): AcpRuntimeCapabilities {
    return {
      controls: ["session/status"],
    };
  }

  async getStatus(input: {
    handle: AcpRuntimeHandle;
    signal?: AbortSignal;
  }): Promise<AcpRuntimeStatus> {
    if (input.signal?.aborted) {
      throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP operation aborted.");
    }
    const state = decodeHandleState(input.handle);
    const status = await this.gatewayRuntime.querySessionStatus({
      invokeNode: this.invokeNode,
      nodeId: state.nodeId,
      sessionKey: state.sessionKey,
      leaseId: state.leaseId,
      leaseEpoch: state.leaseEpoch,
    });
    const reconciledState = await this.gatewayRuntime.normalizeReconnectStatusState({
      sessionKey: state.sessionKey,
      state: status.state,
    });
    return {
      summary:
        typeof status.details?.summary === "string" && status.details.summary.trim()
          ? status.details.summary.trim()
          : `acp-node status: ${reconciledState}`,
      ...(status.nodeRuntimeSessionId ? { backendSessionId: status.nodeRuntimeSessionId } : {}),
      details: {
        nodeId: status.nodeId,
        leaseId: status.leaseId,
        leaseEpoch: status.leaseEpoch,
        state: reconciledState,
        ...(status.nodeWorkerRunId ? { nodeWorkerRunId: status.nodeWorkerRunId } : {}),
        ...(typeof status.workerProtocolVersion === "number"
          ? { workerProtocolVersion: status.workerProtocolVersion }
          : {}),
      },
    };
  }

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    const state = decodeHandleState(input.handle);
    const session = await this.gatewayRuntime.store.getSession(state.sessionKey);
    const runId = session?.activeRunId;
    if (!runId) {
      return;
    }
    await this.requestCancel({
      state,
      runId,
      reason: input.reason,
    });
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    const state = decodeHandleState(input.handle);
    const result = await this.gatewayRuntime.closeSession({
      invokeNode: this.invokeNode,
      nodeId: state.nodeId,
      sessionKey: state.sessionKey,
      leaseId: state.leaseId,
      leaseEpoch: state.leaseEpoch,
      reason: input.reason,
      idempotencyKey: `acp-node:close:${state.sessionKey}:${state.leaseId}:${state.leaseEpoch}`,
    });
    if (!result.ok) {
      throw new AcpRuntimeError(
        "ACP_TURN_FAILED",
        result.error?.message ?? "ACP node session close failed.",
      );
    }
  }

  private async resolveLeaseForEnsure(params: {
    sessionKey: string;
    selectedNodeId: string;
    existingLease: Awaited<ReturnType<AcpGatewayNodeRuntime["store"]["getActiveLease"]>>;
  }) {
    const { sessionKey, selectedNodeId, existingLease } = params;
    if (!existingLease) {
      return await this.gatewayRuntime.store.acquireLease({
        sessionKey,
        nodeId: selectedNodeId,
      });
    }
    if (existingLease.state === "active" && existingLease.nodeId === selectedNodeId) {
      return existingLease;
    }
    if (existingLease.state === "suspect") {
      if (existingLease.nodeId !== selectedNodeId) {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          `ACP session ${sessionKey} is waiting for same-node reconcile on ${existingLease.nodeId}.`,
        );
      }
      return await this.reconcileSuspectLeaseOrThrow({
        sessionKey,
        nodeId: selectedNodeId,
        leaseId: existingLease.leaseId,
        leaseEpoch: existingLease.leaseEpoch,
      });
    }
    return await this.gatewayRuntime.store.acquireLease({
      sessionKey,
      nodeId: selectedNodeId,
    });
  }

  private async reconcileSuspectLeaseOrThrow(params: {
    sessionKey: string;
    nodeId: string;
    leaseId: string;
    leaseEpoch: number;
  }) {
    let status: AcpGatewayNodeSessionStatus;
    try {
      status = await this.gatewayRuntime.querySessionStatus({
        invokeNode: this.invokeNode,
        nodeId: params.nodeId,
        sessionKey: params.sessionKey,
        leaseId: params.leaseId,
        leaseEpoch: params.leaseEpoch,
        idempotencyKey: `acp-node:status:${params.sessionKey}:${params.leaseId}:${params.leaseEpoch}`,
      });
    } catch (error) {
      await this.gatewayRuntime.store.markStatusMismatch({
        sessionKey: params.sessionKey,
      });
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        error instanceof Error ? error.message : "ACP node status reconcile failed.",
        {
          cause: error,
        },
      );
    }
    if (
      status.nodeId !== params.nodeId ||
      status.sessionKey !== params.sessionKey ||
      status.leaseId !== params.leaseId ||
      status.leaseEpoch !== params.leaseEpoch
    ) {
      await this.gatewayRuntime.store.markStatusMismatch({
        sessionKey: params.sessionKey,
      });
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        `ACP node status reconcile failed for session ${params.sessionKey}.`,
      );
    }
    const reconciledState = await this.gatewayRuntime.normalizeReconnectStatusState({
      sessionKey: params.sessionKey,
      state: status.state,
    });
    if (
      reconciledState !== "idle" &&
      reconciledState !== "running" &&
      reconciledState !== "cancelling"
    ) {
      await this.gatewayRuntime.store.markStatusMismatch({
        sessionKey: params.sessionKey,
      });
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        `ACP node status reconcile failed for session ${params.sessionKey}.`,
      );
    }
    return (
      await this.gatewayRuntime.reconcileSuspectLease({
        sessionKey: params.sessionKey,
        nodeId: params.nodeId,
        leaseId: params.leaseId,
        leaseEpoch: params.leaseEpoch,
        state: reconciledState,
        ...(status.nodeRuntimeSessionId
          ? { nodeRuntimeSessionId: status.nodeRuntimeSessionId }
          : {}),
        ...(status.nodeWorkerRunId ? { nodeWorkerRunId: status.nodeWorkerRunId } : {}),
        ...(typeof status.workerProtocolVersion === "number"
          ? { workerProtocolVersion: status.workerProtocolVersion }
          : {}),
      })
    ).lease;
  }

  private async recordRejectedStart(params: {
    state: AcpNodeHandleState;
    runId: string;
    message: string;
  }): Promise<void> {
    await this.gatewayRuntime.store.resolveTerminal({
      nodeId: params.state.nodeId,
      sessionKey: params.state.sessionKey,
      runId: params.runId,
      leaseId: params.state.leaseId,
      leaseEpoch: params.state.leaseEpoch,
      terminalEventId: `gateway-start-rejected:${params.runId}`,
      finalSeq: 0,
      terminal: {
        kind: "failed",
        errorCode: "ACP_TURN_FAILED",
        errorMessage: params.message,
      },
    });
  }

  private async recordUnknownStartOutcome(params: {
    state: AcpNodeHandleState;
    runId: string;
  }): Promise<void> {
    await this.gatewayRuntime.store.markRunRecovering({
      sessionKey: params.state.sessionKey,
      runId: params.runId,
      reason: "start_unknown_transport",
    });
  }

  private async requestCancel(params: {
    state: AcpNodeHandleState;
    runId: string;
    reason?: string;
  }): Promise<void> {
    const result = await this.gatewayRuntime.cancelTurn({
      invokeNode: this.invokeNode,
      nodeId: params.state.nodeId,
      sessionKey: params.state.sessionKey,
      runId: params.runId,
      leaseId: params.state.leaseId,
      leaseEpoch: params.state.leaseEpoch,
      ...(params.reason ? { reason: params.reason } : {}),
      idempotencyKey: `acp-node:cancel:${params.state.sessionKey}:${params.runId}`,
    });
    if (!result.ok) {
      const currentRun = await this.gatewayRuntime.store.getRun(params.runId);
      if (currentRun?.terminal) {
        return;
      }
      throw new AcpRuntimeError(
        "ACP_TURN_FAILED",
        result.error?.message ?? "ACP node turn cancel failed.",
      );
    }
    const payload = parseInvokePayload(result) as AcpNodeInvokePayload;
    if (payload.accepted !== true) {
      const currentRun = await this.gatewayRuntime.store.getRun(params.runId);
      if (currentRun?.terminal) {
        return;
      }
      throw new AcpRuntimeError(
        "ACP_TURN_FAILED",
        payload.message ?? "ACP node turn cancel was not accepted.",
      );
    }
    await this.gatewayRuntime.store.recordCancelRequested({
      sessionKey: params.state.sessionKey,
      runId: params.runId,
    });
  }
}

export function registerAcpNodeRuntimeBackend(params: AcpNodeRuntimeParams): void {
  registerAcpRuntimeBackend({
    id: ACP_NODE_BACKEND_ID,
    runtime: new AcpNodeRuntime(params),
    healthy: () => params.listNodes().some((node) => supportsAcpNode(node)),
  });
}
