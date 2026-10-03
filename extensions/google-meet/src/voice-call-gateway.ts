import {
  GatewayClient,
  startGatewayClientWhenEventLoopReady,
} from "openclaw/plugin-sdk/gateway-runtime";
// Google Meet keeps its labels/config; core owns the voicecall.* delegation contract.
import {
  createMeetingVoiceCallGateway,
  joinMeetingViaVoiceCallGateway,
  type MeetingVoiceCallConfig,
  type MeetingVoiceCallGateway,
  type MeetingVoiceCallGatewayClient,
  type MeetingVoiceCallSurface,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import type { GoogleMeetConfig } from "./config.js";

const GOOGLE_MEET_VOICE_CALL_SURFACE: MeetingVoiceCallSurface = {
  clientDisplayName: "Google Meet plugin",
  configPath: "google-meet voiceCall.gatewayUrl",
  logScope: "[google-meet]",
  meetingLabel: "Meet",
  providerLabel: "Twilio",
};

async function createConnectedGatewayClient(params: {
  config: MeetingVoiceCallConfig;
  surface: MeetingVoiceCallSurface;
}): Promise<MeetingVoiceCallGatewayClient> {
  let client: InstanceType<typeof GatewayClient> | undefined;
  const abortStart = new AbortController();
  try {
    await raceWithTimeout(
      () =>
        new Promise<void>((resolve, reject) => {
          client = new GatewayClient({
            url: params.config.gatewayUrl,
            token: params.config.token,
            requestTimeoutMs: params.config.requestTimeoutMs,
            clientName: "cli",
            clientDisplayName: params.surface.clientDisplayName,
            scopes: ["operator.write"],
            onHelloOk: () => resolve(),
            onConnectError: (error) => {
              abortStart.abort();
              reject(error);
            },
          });
          void startGatewayClientWhenEventLoopReady(client, {
            timeoutMs: params.config.requestTimeoutMs,
            signal: abortStart.signal,
          })
            .then((readiness) => {
              if (!readiness.ready && !readiness.aborted) {
                reject(new Error("gateway event loop readiness timeout"));
              }
            })
            .catch((error: unknown) => {
              reject(error instanceof Error ? error : new Error(String(error)));
            });
        }),
      params.config.requestTimeoutMs,
      () => {
        abortStart.abort();
        throw new Error("gateway connect timeout");
      },
    );
    return client!;
  } catch (error) {
    abortStart.abort();
    await client?.stopAndWait().catch(() => {});
    throw error;
  }
}

export function createVoiceCallGateway(params: {
  config: GoogleMeetConfig;
  runtime: PluginRuntime;
}): MeetingVoiceCallGateway {
  return createMeetingVoiceCallGateway({
    config: params.config.voiceCall,
    runtime: params.runtime,
    surface: GOOGLE_MEET_VOICE_CALL_SURFACE,
    connectClient: createConnectedGatewayClient,
  });
}

export async function joinMeetViaVoiceCallGateway(
  params: Omit<Parameters<typeof joinMeetingViaVoiceCallGateway>[0], "config" | "surface"> & {
    config: GoogleMeetConfig;
  },
): Promise<{ callId: string; dtmfSent: boolean; introSent: boolean }> {
  return await joinMeetingViaVoiceCallGateway({
    ...params,
    config: params.config.voiceCall,
    surface: GOOGLE_MEET_VOICE_CALL_SURFACE,
  });
}
