/**
 * gRPC client bridge to the .NET Teams media worker.
 *
 * The .NET worker owns the full call lifecycle (Graph Communications SDK +
 * Real-Time Media SDK). This bridge provides a typed async API for the TS
 * agent plane to join/leave calls, receive per-speaker audio, send TTS
 * audio, and subscribe to call events.
 *
 * Uses @grpc/proto-loader for dynamic proto loading (no codegen required).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CallEvent,
  ComplianceState,
  UnmixedAudioSegment,
  VoiceOperationResult,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(__dirname, "../../../media-worker/Protos/bridge.proto");

// ---------------------------------------------------------------------------
// Lazy-loaded gRPC dependencies
// ---------------------------------------------------------------------------

type GrpcClient = import("@grpc/grpc-js").Client;

let grpcModule: typeof import("@grpc/grpc-js") | undefined;
let protoLoaderModule: typeof import("@grpc/proto-loader") | undefined;

async function loadGrpc() {
  if (!grpcModule) {
    grpcModule = await import("@grpc/grpc-js");
  }
  if (!protoLoaderModule) {
    protoLoaderModule = await import("@grpc/proto-loader");
  }
  return { grpc: grpcModule, protoLoader: protoLoaderModule };
}

// ---------------------------------------------------------------------------
// Types for gRPC call results (dynamic proto → loosely typed)
// ---------------------------------------------------------------------------

type GrpcJoinResponse = {
  graphCallId?: string;
  success?: boolean;
  error?: string;
};

type GrpcLeaveResponse = {
  success?: boolean;
  error?: string;
};

type GrpcHealthResponse = {
  healthy?: boolean;
  capacity?: {
    activeCalls?: number;
    maxConcurrentCalls?: number;
    cpuUsagePercent?: number;
    memoryUsedBytes?: string;
  };
};

type GrpcAudioSegment = {
  callId?: string;
  speakerId?: number;
  aadUserId?: string;
  displayName?: string;
  durationMs?: number;
  pcmData?: Uint8Array;
  isFinal?: boolean;
};

type GrpcCallEvent = {
  callId?: string;
  compliance?: { status?: string };
  participant?: { action?: string; aadUserId?: string; displayName?: string };
  state?: { state?: string; reason?: string };
  qoe?: { speakerId?: number; packetLoss?: number; jitterMs?: number };
  error?: { message?: string; recoverable?: boolean };
};

// ---------------------------------------------------------------------------
// WorkerBridge
// ---------------------------------------------------------------------------

export type AudioSegmentCallback = (segment: UnmixedAudioSegment) => void;
export type CallEventCallback = (event: CallEvent) => void;

export class WorkerBridge {
  private client: GrpcClient | undefined;
  private address: string;

  constructor(address: string) {
    this.address = address;
  }

  /** Connect to the .NET media worker. */
  async connect(): Promise<void> {
    const { grpc, protoLoader } = await loadGrpc();
    const packageDef = await protoLoader.load(PROTO_PATH, {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(packageDef) as Record<string, unknown>;
    const ns = proto.openclaw as Record<string, unknown>;
    const msteams = ns.msteams as Record<string, unknown>;
    const voice = msteams.voice as Record<string, unknown>;
    const BridgeService = voice.TeamsMediaBridge as new (
      address: string,
      credentials: import("@grpc/grpc-js").ChannelCredentials,
    ) => GrpcClient;

    this.client = new BridgeService(this.address, grpc.credentials.createInsecure());
  }

  /** Check if the worker is reachable and healthy. */
  async healthCheck(): Promise<boolean> {
    if (!this.client) return false;
    try {
      const response = await this.unaryCall<Record<string, never>, GrpcHealthResponse>(
        "healthCheck",
        {},
      );
      return response.healthy === true;
    } catch {
      return false;
    }
  }

  /** Join a Teams meeting. Returns the Graph call ID on success. */
  async joinMeeting(params: {
    callId: string;
    joinUrl: string;
    tenantId: string;
    appId: string;
    appSecret: string;
    receiveUnmixed?: boolean;
  }): Promise<VoiceOperationResult & { graphCallId?: string }> {
    const response = await this.unaryCall<Record<string, unknown>, GrpcJoinResponse>(
      "joinMeeting",
      {
        callId: params.callId,
        joinUrl: params.joinUrl,
        tenantId: params.tenantId,
        appId: params.appId,
        appSecret: params.appSecret,
        receiveUnmixed: params.receiveUnmixed ?? true,
      },
    );

    if (response.success) {
      return {
        ok: true,
        message: `Joined meeting, graph call ID: ${response.graphCallId}`,
        callId: params.callId,
        graphCallId: response.graphCallId,
      };
    }
    return {
      ok: false,
      message: response.error ?? "Failed to join meeting",
      callId: params.callId,
    };
  }

  /** Leave / hang up a call. */
  async leaveCall(callId: string): Promise<VoiceOperationResult> {
    const response = await this.unaryCall<{ callId: string }, GrpcLeaveResponse>("leaveCall", {
      callId,
    });

    return {
      ok: response.success === true,
      message: response.error ?? "Left call",
      callId,
    };
  }

  /**
   * Subscribe to per-speaker unmixed audio segments from the worker.
   * The callback fires for each completed audio segment (after silence
   * detection). Returns a cancel function to stop the subscription.
   */
  subscribeUnmixedAudio(callId: string, callback: AudioSegmentCallback): () => void {
    if (!this.client) throw new Error("WorkerBridge not connected");

    const stream = (
      this.client as unknown as Record<string, (req: unknown) => import("stream").Readable>
    ).subscribeUnmixedAudio({ callId });

    stream.on("data", (data: GrpcAudioSegment) => {
      callback({
        callId: data.callId ?? callId,
        speakerId: data.speakerId ?? 0,
        aadUserId: data.aadUserId ?? "",
        displayName: data.displayName,
        durationMs: data.durationMs ?? 0,
        pcmData: data.pcmData ?? new Uint8Array(0),
        isFinal: data.isFinal ?? false,
      });
    });

    return () => {
      stream.destroy();
    };
  }

  /**
   * Subscribe to call events (state changes, participants, compliance,
   * QoE, errors). Returns a cancel function.
   */
  subscribeEvents(callId: string, callback: CallEventCallback): () => void {
    if (!this.client) throw new Error("WorkerBridge not connected");

    const stream = (
      this.client as unknown as Record<string, (req: unknown) => import("stream").Readable>
    ).subscribeEvents({ callId });

    stream.on("data", (data: GrpcCallEvent) => {
      const event = parseCallEvent(data, callId);
      if (event) callback(event);
    });

    return () => {
      stream.destroy();
    };
  }

  /**
   * Stream TTS audio to the worker for playback injection.
   * Sends PCM chunks (16kHz mono 16-bit) for the given call.
   */
  async playAudio(callId: string, pcmChunks: Uint8Array[]): Promise<void> {
    if (!this.client) throw new Error("WorkerBridge not connected");

    const stream = (
      this.client as unknown as Record<
        string,
        (callback: (err: Error | null, response: unknown) => void) => import("stream").Writable
      >
    ).playAudio((_err: Error | null) => {
      // Response callback — fire-and-forget for now.
    });

    for (const chunk of pcmChunks) {
      stream.write({ callId, pcmData: chunk });
    }
    stream.end();
  }

  /** Stop playback immediately (barge-in). */
  async stopPlayback(callId: string): Promise<void> {
    await this.unaryCall("stopPlayback", { callId });
  }

  /** Disconnect from the worker. */
  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.close();
      this.client = undefined;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private unaryCall<TReq, TRes>(method: string, request: TReq): Promise<TRes> {
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new Error("WorkerBridge not connected"));
        return;
      }
      (
        this.client as unknown as Record<
          string,
          (req: TReq, callback: (err: Error | null, response: TRes) => void) => void
        >
      )[method](request, (err, response) => {
        if (err) reject(err);
        else resolve(response);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

function parseCallEvent(raw: GrpcCallEvent, fallbackCallId: string): CallEvent | undefined {
  const callId = raw.callId ?? fallbackCallId;

  if (raw.compliance) {
    return {
      type: "compliance",
      callId,
      status: (raw.compliance.status ?? "awaiting") as ComplianceState,
    };
  }
  if (raw.participant) {
    return {
      type: "participant",
      callId,
      action: (raw.participant.action ?? "joined") as "joined" | "left" | "muted" | "unmuted",
      aadUserId: raw.participant.aadUserId ?? "",
      displayName: raw.participant.displayName,
    };
  }
  if (raw.state) {
    return {
      type: "state",
      callId,
      state: (raw.state.state ?? "establishing") as "establishing" | "established" | "terminated",
      reason: raw.state.reason,
    };
  }
  if (raw.qoe) {
    return {
      type: "qoe",
      callId,
      speakerId: raw.qoe.speakerId ?? 0,
      packetLoss: raw.qoe.packetLoss ?? 0,
      jitterMs: raw.qoe.jitterMs ?? 0,
    };
  }
  if (raw.error) {
    return {
      type: "error",
      callId,
      message: raw.error.message ?? "Unknown error",
      recoverable: raw.error.recoverable ?? false,
    };
  }
  return undefined;
}
