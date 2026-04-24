import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import type { GoogleMeetConfig } from "../config.js";
import {
  startCommandRealtimeAudioBridge,
  type ChromeRealtimeAudioBridgeHandle,
} from "../realtime.js";

export function outputMentionsBlackHole2ch(output: string): boolean {
  return /\bBlackHole\s+2ch\b/i.test(output);
}

export async function assertBlackHole2chAvailable(params: {
  runtime: PluginRuntime;
  timeoutMs: number;
}): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Chrome Meet transport with blackhole-2ch audio is currently macOS-only");
  }

  const result = await params.runtime.system.runCommandWithTimeout(
    ["system_profiler", "SPAudioDataType"],
    { timeoutMs: params.timeoutMs },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.code !== 0 || !outputMentionsBlackHole2ch(output)) {
    const hint =
      params.runtime.system.formatNativeDependencyHint?.({
        packageName: "BlackHole 2ch",
        downloadCommand: "brew install blackhole-2ch",
      }) ?? "";
    throw new Error(
      [
        "BlackHole 2ch audio device not found.",
        "Install BlackHole 2ch and route Chrome input/output through the OpenClaw audio bridge.",
        hint,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
}

export async function launchChromeMeet(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  meetingSessionId: string;
  mode: "realtime" | "transcribe";
  url: string;
  logger: RuntimeLogger;
}): Promise<{
  launched: boolean;
  audioBridge?:
    | { type: "external-command" }
    | ({ type: "command-pair" } & ChromeRealtimeAudioBridgeHandle);
}> {
  await assertBlackHole2chAvailable({
    runtime: params.runtime,
    timeoutMs: Math.min(params.config.chrome.joinTimeoutMs, 10_000),
  });

  if (params.config.chrome.audioBridgeHealthCommand) {
    const health = await params.runtime.system.runCommandWithTimeout(
      params.config.chrome.audioBridgeHealthCommand,
      { timeoutMs: params.config.chrome.joinTimeoutMs },
    );
    if (health.code !== 0) {
      throw new Error(
        `Chrome audio bridge health check failed: ${health.stderr || health.stdout || health.code}`,
      );
    }
  }

  let audioBridge:
    | { type: "external-command" }
    | ({ type: "command-pair" } & ChromeRealtimeAudioBridgeHandle)
    | undefined;

  if (params.config.chrome.audioBridgeCommand) {
    const bridge = await params.runtime.system.runCommandWithTimeout(
      params.config.chrome.audioBridgeCommand,
      { timeoutMs: params.config.chrome.joinTimeoutMs },
    );
    if (bridge.code !== 0) {
      throw new Error(
        `failed to start Chrome audio bridge: ${bridge.stderr || bridge.stdout || bridge.code}`,
      );
    }
    audioBridge = { type: "external-command" };
  } else if (params.mode === "realtime") {
    if (!params.config.chrome.audioInputCommand || !params.config.chrome.audioOutputCommand) {
      throw new Error(
        "Chrome realtime mode requires chrome.audioInputCommand and chrome.audioOutputCommand, or chrome.audioBridgeCommand for an external bridge.",
      );
    }
    audioBridge = {
      type: "command-pair",
      ...(await startCommandRealtimeAudioBridge({
        config: params.config,
        fullConfig: params.fullConfig,
        runtime: params.runtime,
        meetingSessionId: params.meetingSessionId,
        inputCommand: params.config.chrome.audioInputCommand,
        outputCommand: params.config.chrome.audioOutputCommand,
        logger: params.logger,
      })),
    };
  }

  if (!params.config.chrome.launch) {
    return { launched: false, audioBridge };
  }

  const argv = ["open", "-a", "Google Chrome"];
  if (params.config.chrome.browserProfile) {
    argv.push("--args", `--profile-directory=${params.config.chrome.browserProfile}`);
  }
  argv.push(params.url);

  let commandPairBridgeStopped = false;
  const stopCommandPairBridge = async () => {
    if (commandPairBridgeStopped) {
      return;
    }
    commandPairBridgeStopped = true;
    if (audioBridge?.type === "command-pair") {
      await audioBridge.stop();
    }
  };

  try {
    const result = await params.runtime.system.runCommandWithTimeout(argv, {
      timeoutMs: params.config.chrome.joinTimeoutMs,
    });
    if (result.code === 0) {
      return { launched: true, audioBridge };
    }
    await stopCommandPairBridge();
    throw new Error(
      `failed to launch Chrome for Meet: ${result.stderr || result.stdout || result.code}`,
    );
  } catch (error) {
    await stopCommandPairBridge();
    throw error;
  }
}
