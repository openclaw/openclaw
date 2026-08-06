import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { FACETIME_FEED_DEVICE_NAME, FACETIME_MIC_DEVICE_NAME, SOX_COMMAND } from "./audio-pump.js";

type RunCommandWithTimeout = PluginRuntime["system"]["runCommandWithTimeout"];

export function pairedAudioProbeCommands(): Array<{ label: string; argv: string[] }> {
  return [
    {
      label: FACETIME_FEED_DEVICE_NAME,
      argv: [
        SOX_COMMAND,
        "-q",
        "-n",
        "-t",
        "coreaudio",
        FACETIME_FEED_DEVICE_NAME,
        "trim",
        "0",
        "0.05",
      ],
    },
    {
      label: FACETIME_MIC_DEVICE_NAME,
      argv: [
        SOX_COMMAND,
        "-q",
        "-t",
        "coreaudio",
        FACETIME_MIC_DEVICE_NAME,
        "-n",
        "trim",
        "0",
        "0.05",
      ],
    },
  ];
}

export async function assertPairedAudioTransport(
  runCommandWithTimeout: RunCommandWithTimeout,
): Promise<void> {
  for (const { label, argv } of pairedAudioProbeCommands()) {
    const probe = await runCommandWithTimeout(argv, { timeoutMs: 3_000 });
    if (probe.code !== 0) {
      throw new Error(
        `${label} audio probe failed: ${probe.stderr || probe.stdout || `exit ${probe.code}`}`,
      );
    }
  }
}
