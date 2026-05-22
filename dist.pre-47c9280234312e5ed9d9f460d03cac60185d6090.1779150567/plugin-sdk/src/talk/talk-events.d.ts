export declare const TALK_EVENT_TYPES: readonly ["session.started", "session.ready", "session.closed", "session.error", "session.replaced", "turn.started", "turn.ended", "turn.cancelled", "capture.started", "capture.stopped", "capture.cancelled", "capture.once", "input.audio.delta", "input.audio.committed", "transcript.delta", "transcript.done", "output.text.delta", "output.text.done", "output.audio.started", "output.audio.delta", "output.audio.done", "tool.call", "tool.progress", "tool.result", "tool.error", "usage.metrics", "latency.metrics", "health.changed"];
export type TalkEventType = (typeof TALK_EVENT_TYPES)[number];
export type TalkMode = "realtime" | "stt-tts" | "transcription";
export type TalkTransport = "webrtc" | "provider-websocket" | "gateway-relay" | "managed-room";
export type TalkBrain = "agent-consult" | "direct-tools" | "none";
export type TalkEventContext = {
    sessionId: string;
    mode: TalkMode;
    transport: TalkTransport;
    brain: TalkBrain;
    provider?: string;
};
export type TalkEvent<TPayload = unknown> = TalkEventContext & {
    id: string;
    type: TalkEventType;
    turnId?: string;
    captureId?: string;
    seq: number;
    timestamp: string;
    final?: boolean;
    callId?: string;
    itemId?: string;
    parentId?: string;
    payload: TPayload;
};
export type TalkEventInput<TPayload = unknown> = {
    type: TalkEventType;
    payload: TPayload;
    turnId?: string;
    captureId?: string;
    timestamp?: string;
    final?: boolean;
    callId?: string;
    itemId?: string;
    parentId?: string;
};
export type TalkEventSequencer = {
    next<TPayload>(input: TalkEventInput<TPayload>): TalkEvent<TPayload>;
};
export declare function createTalkEventSequencer(context: TalkEventContext, options?: {
    now?: () => Date | string;
}): TalkEventSequencer;
