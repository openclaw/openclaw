// Google Meet plugin module implements voice call gateway behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  GatewayClient,
  startGatewayClientWhenEventLoopReady,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import type { GoogleMeetConfig } from "./config.js";

type VoiceCallGatewayClient = InstanceType<typeof GatewayClient>;

export type VoiceCallGateway = {
  trustedPluginIdentity: boolean;
  request: <T>(method: string, params: Record<string, unknown>) => Promise<T>;
};

type VoiceCallStartResult = {
  callId?: string;
  initiated?: boolean;
  error?: string;
};

type VoiceCallSpeakResult = {
  success?: boolean;
  error?: string;
};

type VoiceCallStatusResult = {
  found?: boolean;
  call?: unknown;
};

type VoiceCallMeetJoinResult = {
  callId: string;
  dtmfSent: boolean;
  introSent: boolean;
};

async function createConnectedGatewayClient(
  config: GoogleMeetConfig,
): Promise<VoiceCallGatewayClient> {
  let client: VoiceCallGatewayClient;
  await new Promise<void>((resolve, reject) => {
    const abortStart = new AbortController();
    const timer = setTimeout(() => {
      abortStart.abort();
      reject(new Error("gateway connect timeout"));
    }, config.voiceCall.requestTimeoutMs);
    client = new GatewayClient({
      url: config.voiceCall.gatewayUrl,
      token: config.voiceCall.token,
      requestTimeoutMs: config.voiceCall.requestTimeoutMs,
      clientName: "cli",
      clientDisplayName: "Google Meet plugin",
      scopes: ["operator.write"],
      onHelloOk: () => {
        clearTimeout(timer);
        resolve();
      },
      onConnectError: (err) => {
        clearTimeout(timer);
        abortStart.abort();
        reject(err);
      },
    });
    void startGatewayClientWhenEventLoopReady(client, {
      timeoutMs: config.voiceCall.requestTimeoutMs,
      signal: abortStart.signal,
    })
      .then((readiness) => {
        if (!readiness.ready && !readiness.aborted) {
          clearTimeout(timer);
          reject(new Error("gateway event loop readiness timeout"));
        }
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
  return client!;
}

export function createVoiceCallGateway(params: {
  config: GoogleMeetConfig;
  runtime: PluginRuntime;
}): VoiceCallGateway {
  if (!params.config.voiceCall.gatewayUrl) {
    return {
      trustedPluginIdentity: true,
      request: (method, requestParams) =>
        params.runtime.gateway.request(method, requestParams, {
          timeoutMs: params.config.voiceCall.requestTimeoutMs,
        }),
    };
  }
  return {
    trustedPluginIdentity: false,
    async request<T>(method: string, requestParams: Record<string, unknown>): Promise<T> {
      const client = await createConnectedGatewayClient(params.config);
      try {
        return (await client.request(method, requestParams, {
          timeoutMs: params.config.voiceCall.requestTimeoutMs,
        })) as T;
      } finally {
        await client.stopAndWait({ timeoutMs: 1_000 });
      }
    },
  };
}

export function isVoiceCallMissingError(error: unknown): boolean {
  const message = formatErrorMessage(error).toLowerCase();
  return message.includes("call not found") || message.includes("call is not active");
}

export async function joinMeetViaVoiceCallGateway(params: {
  config: GoogleMeetConfig;
  gateway: VoiceCallGateway;
  dialInNumber: string;
  dtmfSequence?: string;
  logger?: RuntimeLogger;
  message?: string;
  requesterSessionKey?: string;
  agentId?: string;
  sessionKey?: string;
}): Promise<VoiceCallMeetJoinResult> {
  const requiresTrustedAgentRouting = params.agentId && params.agentId !== "main";
  if (requiresTrustedAgentRouting && !params.gateway.trustedPluginIdentity) {
    throw new Error(
      "Per-agent Voice Call routing requires the local Gateway runtime. Remove google-meet voiceCall.gatewayUrl or omit agent routing.",
    );
  }
  params.logger?.info(
    `[google-meet] Delegating Twilio join to Voice Call (dtmf=${params.dtmfSequence ? "pre-connect" : "none"}, intro=${params.message ? "delayed" : "none"})`,
  );
  const start = await params.gateway.request<VoiceCallStartResult>("voicecall.start", {
    to: params.dialInNumber,
    mode: "conversation",
    ...(params.dtmfSequence ? { dtmfSequence: params.dtmfSequence } : {}),
    ...(params.requesterSessionKey ? { requesterSessionKey: params.requesterSessionKey } : {}),
    ...(params.agentId && params.gateway.trustedPluginIdentity ? { agentId: params.agentId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
  if (!start.callId) {
    throw new Error(start.error || "voicecall.start did not return callId");
  }
  params.logger?.info(`[google-meet] Voice Call Twilio phone leg started: callId=${start.callId}`);
  const dtmfSent = Boolean(params.dtmfSequence);
  if (dtmfSent) {
    params.logger?.info(
      `[google-meet] Meet DTMF queued before realtime connect: callId=${start.callId} digits=${params.dtmfSequence?.length ?? 0}`,
    );
  }
  let introSent = false;
  if (params.message) {
    const delayMs = params.dtmfSequence ? params.config.voiceCall.postDtmfSpeechDelayMs : 0;
    if (delayMs > 0) {
      params.logger?.info(
        `[google-meet] Waiting ${delayMs}ms after Meet DTMF before speaking intro for callId=${start.callId}`,
      );
      await sleep(delayMs);
    }
    let spoken: VoiceCallSpeakResult;
    try {
      spoken = await params.gateway.request<VoiceCallSpeakResult>("voicecall.speak", {
        callId: start.callId,
        allowTwimlFallback: false,
        message: params.message,
      });
    } catch (err) {
      params.logger?.warn?.(
        `[google-meet] Skipped intro speech because realtime bridge was not ready: ${formatErrorMessage(err)}`,
      );
      spoken = { success: false };
    }
    if (spoken.success === false) {
      params.logger?.warn?.(
        `[google-meet] Skipped intro speech because realtime bridge was not ready: ${
          spoken.error || "voicecall.speak failed"
        }`,
      );
    } else {
      introSent = true;
      params.logger?.info(
        `[google-meet] Intro speech requested after Meet dial sequence: callId=${start.callId}`,
      );
    }
  }
  return {
    callId: start.callId,
    dtmfSent,
    introSent,
  };
}

export async function endMeetVoiceCallGatewayCall(params: {
  gateway: VoiceCallGateway;
  callId: string;
}): Promise<void> {
  try {
    await params.gateway.request("voicecall.end", { callId: params.callId });
  } catch (err) {
    if (!isVoiceCallMissingError(err)) {
      throw err;
    }
  }
}

export async function getMeetVoiceCallGatewayCall(params: {
  gateway: VoiceCallGateway;
  callId: string;
}): Promise<VoiceCallStatusResult> {
  return await params.gateway.request<VoiceCallStatusResult>("voicecall.status", {
    callId: params.callId,
  });
}

export async function speakMeetViaVoiceCallGateway(params: {
  gateway: VoiceCallGateway;
  callId: string;
  message: string;
}): Promise<void> {
  const spoken = await params.gateway.request<VoiceCallSpeakResult>("voicecall.speak", {
    callId: params.callId,
    message: params.message,
  });
  if (spoken.success === false) {
    throw new Error(spoken.error || "voicecall.speak failed");
  }
}
