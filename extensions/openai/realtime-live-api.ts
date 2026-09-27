import { z } from "zod";
import type { OpenAIRealtimeHost } from "./realtime-host.js";

export const OPENAI_LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
const LIVE_RESPONSE_MAX_BYTES = 512 * 1024;
const sessionIdentitySchema = z.object({ session: z.object({ id: z.string().min(1).max(512) }) });
const transportSchema = z.object({
  transport: z.object({
    type: z.literal("webrtc"),
    sdp: z
      .string()
      .min(1)
      .max(256 * 1024),
  }),
});

export async function createOpenAILiveCall(
  params: {
    apiKey: string;
    sdp: string;
    session: object;
    onCallAllocated?: (callId: string) => void;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  },
  runtime: OpenAIRealtimeHost,
) {
  const response = await (params.fetchImpl ?? fetch)(OPENAI_LIVE_SESSIONS_URL, {
    method: "POST",
    headers: {
      ...runtime.resolveProviderRequestHeaders({
        provider: "openai",
        baseUrl: OPENAI_LIVE_SESSIONS_URL,
        capability: "audio",
        transport: "http",
        defaultHeaders: {},
      }),
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: params.session,
      transport: { type: "webrtc", sdp: params.sdp },
    }),
    signal: params.signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `GPT-Live session creation failed (${response.status}). Verify Platform model access.`,
    );
  }
  const payload = await runtime.readProviderJsonResponse<unknown>(response, "GPT-Live session", {
    maxBytes: LIVE_RESPONSE_MAX_BYTES,
  });
  const identity = sessionIdentitySchema.safeParse(payload);
  if (!identity.success) {
    throw new Error("GPT-Live session response has no valid session id");
  }
  const callId = identity.data.session.id;
  // Retain the allocation before validating SDP so malformed answers still get retired.
  params.onCallAllocated?.(callId);
  const transport = transportSchema.safeParse(payload);
  if (!transport.success || !transport.data.transport.sdp.trim()) {
    throw new Error("GPT-Live session response has no valid WebRTC answer");
  }
  return {
    kind: "gpt-live" as const,
    status: response.status,
    answerSdp: transport.data.transport.sdp,
    callId,
    sidebandUrl: `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(callId)}/attach`,
  };
}

export async function hangupOpenAILiveCall(
  params: {
    apiKey: string;
    callId: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  },
  runtime: OpenAIRealtimeHost,
): Promise<void> {
  const url = `${OPENAI_LIVE_SESSIONS_URL}/${encodeURIComponent(params.callId)}/hangup`;
  const response = await (params.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: {
      ...runtime.resolveProviderRequestHeaders({
        provider: "openai",
        baseUrl: url,
        capability: "audio",
        transport: "http",
        defaultHeaders: {},
      }),
      Authorization: `Bearer ${params.apiKey}`,
    },
    signal: params.signal,
  });
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok && response.status !== 404) {
    throw new Error(`GPT-Live session hangup failed (${response.status})`);
  }
}
