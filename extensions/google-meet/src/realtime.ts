import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveConfiguredCapabilityProvider } from "openclaw/plugin-sdk/provider-selection-runtime";
import {
  createRealtimeVoiceBridgeSession,
  getRealtimeVoiceProvider,
  listRealtimeVoiceProviders,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import type { GoogleMeetConfig } from "./config.js";

type BridgeProcess = {
  pid?: number;
  killed?: boolean;
  stdin?: Writable | null;
  stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};

type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: ["pipe" | "ignore", "pipe" | "ignore", "pipe" | "ignore"] },
) => BridgeProcess;

export type ChromeRealtimeAudioBridgeHandle = {
  providerId: string;
  inputCommand: string[];
  outputCommand: string[];
  stop: () => Promise<void>;
};

type ResolvedRealtimeProvider = {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
};

function splitCommand(argv: string[]): { command: string; args: string[] } {
  const [command, ...args] = argv;
  if (!command) {
    throw new Error("audio bridge command must not be empty");
  }
  return { command, args };
}

export function resolveGoogleMeetRealtimeProvider(params: {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  providers?: RealtimeVoiceProviderPlugin[];
}): ResolvedRealtimeProvider {
  const configuredProviderId = params.config.realtime.provider;
  const providers = params.providers ?? listRealtimeVoiceProviders(params.fullConfig);
  const resolution = resolveConfiguredCapabilityProvider({
    configuredProviderId,
    providerConfigs: params.config.realtime.providers,
    cfg: params.fullConfig,
    cfgForResolve: params.fullConfig,
    getConfiguredProvider: (providerId) =>
      params.providers?.find((entry) => entry.id === providerId) ??
      getRealtimeVoiceProvider(providerId, params.fullConfig),
    listProviders: () => providers,
    resolveProviderConfig: ({ provider, cfg, rawConfig }) => {
      const withModel =
        params.config.realtime.model && rawConfig.model === undefined
          ? { ...rawConfig, model: params.config.realtime.model }
          : rawConfig;
      return provider.resolveConfig?.({ cfg, rawConfig: withModel }) ?? withModel;
    },
    isProviderConfigured: ({ provider, cfg, providerConfig }) =>
      provider.isConfigured({ cfg, providerConfig }),
  });

  if (!resolution.ok && resolution.code === "missing-configured-provider") {
    throw new Error(
      `Realtime voice provider "${resolution.configuredProviderId}" is not registered`,
    );
  }
  if (!resolution.ok && resolution.code === "no-registered-provider") {
    throw new Error("No configured realtime voice provider registered");
  }
  if (!resolution.ok) {
    throw new Error(`Realtime voice provider "${resolution.provider?.id}" is not configured`);
  }

  return {
    provider: resolution.provider,
    providerConfig: resolution.providerConfig,
  };
}

export async function startCommandRealtimeAudioBridge(params: {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  inputCommand: string[];
  outputCommand: string[];
  logger: RuntimeLogger;
  providers?: RealtimeVoiceProviderPlugin[];
  spawn?: SpawnFn;
}): Promise<ChromeRealtimeAudioBridgeHandle> {
  const input = splitCommand(params.inputCommand);
  const output = splitCommand(params.outputCommand);
  const spawnFn: SpawnFn =
    params.spawn ??
    ((command, args, options) => spawn(command, args, options) as unknown as BridgeProcess);
  const outputProcess = spawnFn(output.command, output.args, {
    stdio: ["pipe", "ignore", "pipe"],
  });
  const inputProcess = spawnFn(input.command, input.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stopped = false;
  let bridge: RealtimeVoiceBridgeSession | null = null;

  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    try {
      bridge?.close();
    } catch (error) {
      params.logger.debug?.(
        `[google-meet] realtime voice bridge close ignored: ${formatErrorMessage(error)}`,
      );
    }
    inputProcess.kill("SIGTERM");
    outputProcess.kill("SIGTERM");
  };

  const fail = (label: string) => (error: Error) => {
    params.logger.warn(`[google-meet] ${label} failed: ${formatErrorMessage(error)}`);
    void stop();
  };
  inputProcess.on("error", fail("audio input command"));
  outputProcess.on("error", fail("audio output command"));
  inputProcess.on("exit", (code, signal) => {
    if (!stopped) {
      params.logger.warn(`[google-meet] audio input command exited (${code ?? signal ?? "done"})`);
      void stop();
    }
  });
  outputProcess.on("exit", (code, signal) => {
    if (!stopped) {
      params.logger.warn(`[google-meet] audio output command exited (${code ?? signal ?? "done"})`);
      void stop();
    }
  });
  inputProcess.stderr?.on("data", (chunk) => {
    params.logger.debug?.(`[google-meet] audio input: ${String(chunk).trim()}`);
  });
  outputProcess.stderr?.on("data", (chunk) => {
    params.logger.debug?.(`[google-meet] audio output: ${String(chunk).trim()}`);
  });

  const resolved = resolveGoogleMeetRealtimeProvider({
    config: params.config,
    fullConfig: params.fullConfig,
    providers: params.providers,
  });
  bridge = createRealtimeVoiceBridgeSession({
    provider: resolved.provider,
    providerConfig: resolved.providerConfig,
    instructions: params.config.realtime.instructions,
    audioSink: {
      isOpen: () => !stopped,
      sendAudio: (muLaw) => {
        outputProcess.stdin?.write(muLaw);
      },
      sendMark: () => {
        bridge?.acknowledgeMark();
      },
    },
    onTranscript: (role, text, isFinal) => {
      if (isFinal) {
        params.logger.debug?.(`[google-meet] ${role}: ${text}`);
      }
    },
    onError: fail("realtime voice bridge"),
    onClose: (reason) => {
      if (reason === "error") {
        void stop();
      }
    },
  });

  inputProcess.stdout?.on("data", (chunk) => {
    const audio = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!stopped && audio.byteLength > 0) {
      bridge?.sendAudio(Buffer.from(audio));
    }
  });

  await bridge.connect();
  return {
    providerId: resolved.provider.id,
    inputCommand: params.inputCommand,
    outputCommand: params.outputCommand,
    stop,
  };
}
