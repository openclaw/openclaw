import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import {
  FACETIME_AUDIO_SAMPLE_RATE_HZ,
  FACETIME_FEED_DEVICE_NAME,
  FACETIME_MIC_DEVICE_NAME,
} from "./audio-pump.js";
import type { FaceTimeConfig } from "./config.js";
import { formatErrorMessage } from "./errors.js";

type RunCommandWithTimeout = PluginRuntime["system"]["runCommandWithTimeout"];

type AudioDeviceDescription = {
  isAggregate: boolean;
  name: string;
  uid: string;
};

type DefaultAudioDevices = {
  input: AudioDeviceDescription;
  output: AudioDeviceDescription;
};

export type FaceTimePreflightCheck = {
  id: string;
  label: string;
  ok: boolean;
  required: boolean;
  message?: string;
};

export type FaceTimePreflightResult = {
  ok: boolean;
  helperConnected: boolean;
  currentAudioDefaults?: DefaultAudioDevices;
  currentAudioError?: string;
  checks: FaceTimePreflightCheck[];
};

function firstLine(value: unknown) {
  return `${value ?? ""}`.trim().split(/\r?\n/u)[0] || undefined;
}

function shellSingleQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function pushCheck(
  checks: FaceTimePreflightCheck[],
  check: Omit<FaceTimePreflightCheck, "required"> & { required?: boolean },
) {
  checks.push({ required: true, ...check });
}

export function parseCoreAudioDeviceNames(systemProfilerOutput: string): string[] {
  const names: string[] = [];
  for (const line of systemProfilerOutput.split(/\r?\n/u)) {
    const match = line.match(/^\s{8}(.+):\s*$/u);
    if (match?.[1]) {
      names.push(match[1].trim());
    }
  }
  return [...new Set(names)];
}

export function findPhysicalOutputProblem(defaults: DefaultAudioDevices): string | undefined {
  if (defaults.output.isAggregate) {
    return `system output is aggregate device ${defaults.output.name}`;
  }
  if (/BlackHole|OpenClaw-(?:Feed|Mic)/iu.test(defaults.output.name)) {
    return `system output is virtual device ${defaults.output.name}`;
  }
  return undefined;
}

async function checkSox(params: {
  runCommandWithTimeout: RunCommandWithTimeout;
  checks: FaceTimePreflightCheck[];
}) {
  for (const command of ["/opt/homebrew/bin/sox", "/usr/local/bin/sox", "sox"]) {
    const result = await params.runCommandWithTimeout([command, "--version"], {
      timeoutMs: 5_000,
    });
    if (result.code === 0) {
      pushCheck(params.checks, {
        id: "sox",
        label: "SoX command",
        ok: true,
        message: firstLine(result.stdout) ?? command,
      });
      return;
    }
    if (!/ENOENT/iu.test(`${result.stderr ?? ""}`)) {
      pushCheck(params.checks, {
        id: "sox",
        label: "SoX command",
        ok: false,
        message: firstLine(result.stderr) ?? firstLine(result.stdout),
      });
      return;
    }
  }
  pushCheck(params.checks, {
    id: "sox",
    label: "SoX command",
    ok: false,
    message: "SoX not found; run brew install sox",
  });
}

async function checkCallApp(params: {
  runCommandWithTimeout: RunCommandWithTimeout;
  checks: FaceTimePreflightCheck[];
}) {
  for (const app of ["FaceTime", "Phone"]) {
    const result = await params.runCommandWithTimeout(["/usr/bin/pgrep", "-x", app], {
      timeoutMs: 5_000,
    });
    if (result.code === 0) {
      pushCheck(params.checks, {
        id: "call-app-running",
        label: "FaceTime or Phone process",
        ok: true,
        message: app,
      });
      return;
    }
  }
  pushCheck(params.checks, {
    id: "call-app-running",
    label: "FaceTime or Phone process",
    ok: false,
    message: "open FaceTime for video calls or Phone for FaceTime audio calls",
  });
}

async function checkPairedDriverLoopback(params: {
  runCommandWithTimeout: RunCommandWithTimeout;
  checks: FaceTimePreflightCheck[];
}) {
  const microphone = shellSingleQuote(FACETIME_MIC_DEVICE_NAME);
  const feed = shellSingleQuote(FACETIME_FEED_DEVICE_NAME);
  const script = `
set -euo pipefail
if [[ -x /opt/homebrew/bin/sox ]]; then sox=/opt/homebrew/bin/sox
elif [[ -x /usr/local/bin/sox ]]; then sox=/usr/local/bin/sox
else sox=sox
fi
capture="$(mktemp -t openclaw-facetime-paired-capture.XXXXXX.raw)"
source="$(mktemp -t openclaw-facetime-paired-source.XXXXXX.raw)"
cleanup() {
  /bin/unlink "$capture" >/dev/null 2>&1 || true
  /bin/unlink "$source" >/dev/null 2>&1 || true
}
trap cleanup EXIT
"$sox" -q -n -t raw -r ${FACETIME_AUDIO_SAMPLE_RATE_HZ} -c 1 -e signed-integer -b 16 -L "$source" synth 2 sine 880 vol 0.2
"$sox" -q -t coreaudio ${microphone} -t raw -r 48000 -c 1 -e signed-integer -b 16 -L "$capture" trim 0 3 &
recpid=$!
sleep 0.3
"$sox" -q --buffer 480 -t raw -r ${FACETIME_AUDIO_SAMPLE_RATE_HZ} -c 1 -e signed-integer -b 16 -L "$source" -t coreaudio ${feed}
wait "$recpid" || true
stat="$("$sox" -q -t raw -r 48000 -c 1 -e signed-integer -b 16 -L "$capture" -n stat 2>&1)"
rms="$(printf "%s\\n" "$stat" | awk '/RMS[[:space:]]+amplitude/ { print $3; exit }')"
node -e 'const rms=Number(process.argv[1]); if (!Number.isFinite(rms) || rms < 0.005) process.exit(1)' "$rms"
printf 'paired-driver rms=%s\\n' "$rms"
`;
  const result = await params.runCommandWithTimeout(["/bin/bash", "-lc", script], {
    timeoutMs: 10_000,
  });
  pushCheck(params.checks, {
    id: "paired-driver-loopback",
    label: "OpenClaw-Feed to OpenClaw-Mic loopback",
    ok: result.code === 0,
    message:
      firstLine(result.stdout) ?? firstLine(result.stderr) ?? "no paired-driver signal detected",
  });
}

async function hasProviderCredential(params: {
  config: FaceTimeConfig;
  fullConfig: OpenClawConfig;
}): Promise<boolean> {
  const providerId = params.config.realtime.provider;
  const providerConfig = params.config.realtime.providers[providerId];
  if (providerConfig && Object.hasOwn(providerConfig, "apiKey")) {
    const resolved = await resolveConfiguredSecretInputString({
      config: params.fullConfig,
      env: process.env,
      value: providerConfig.apiKey,
      path: `plugins.entries.facetime.config.realtime.providers.${providerId}.apiKey`,
    });
    return Boolean(resolved.value);
  }
  const modelProvider = params.fullConfig.models?.providers?.[providerId];
  if (modelProvider && Object.hasOwn(modelProvider, "apiKey")) {
    const resolved = await resolveConfiguredSecretInputString({
      config: params.fullConfig,
      env: process.env,
      value: modelProvider.apiKey,
      path: `models.providers.${providerId}.apiKey`,
    });
    return Boolean(resolved.value);
  }
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export async function runFaceTimePreflight(params: {
  config: FaceTimeConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger?: RuntimeLogger;
  helperConnected: boolean;
  captureBinary: string;
}): Promise<FaceTimePreflightResult> {
  const runCommandWithTimeout = params.runtime.system.runCommandWithTimeout;
  const checks: FaceTimePreflightCheck[] = [];
  pushCheck(checks, {
    id: "helper-connected",
    label: "FaceTime helper socket",
    ok: params.helperConnected,
    message: params.helperConnected
      ? "helper connected"
      : `no helper connected on ${params.config.helperHost}:${params.config.helperPort}`,
  });

  await checkSox({ runCommandWithTimeout, checks });

  const executable = await runCommandWithTimeout(["/bin/test", "-x", params.captureBinary], {
    timeoutMs: 5_000,
  });
  pushCheck(checks, {
    id: "capture-binary",
    label: "FaceTime process-tap capture helper",
    ok: executable.code === 0,
    message:
      executable.code === 0
        ? params.captureBinary
        : "capture helper is missing; restart the gateway to rebuild plugin artifacts",
  });

  await checkCallApp({ runCommandWithTimeout, checks });

  const profiler = await runCommandWithTimeout(["/usr/sbin/system_profiler", "SPAudioDataType"], {
    timeoutMs: 10_000,
  });
  const deviceNames = profiler.code === 0 ? parseCoreAudioDeviceNames(profiler.stdout ?? "") : [];
  for (const [id, label, deviceName] of [
    ["paired-driver-mic", "OpenClaw microphone device", FACETIME_MIC_DEVICE_NAME],
    ["paired-driver-feed", "OpenClaw feed device", FACETIME_FEED_DEVICE_NAME],
  ] as const) {
    const found = deviceNames.includes(deviceName);
    pushCheck(checks, {
      id,
      label,
      ok: found,
      message: found
        ? deviceName
        : `missing ${deviceName}; run openclaw gateway call facetime.installDriver --json`,
    });
  }

  let currentAudioDefaults: DefaultAudioDevices | undefined;
  let currentAudioError: string | undefined;
  if (executable.code === 0) {
    const defaults = await runCommandWithTimeout([params.captureBinary, "--default-devices"], {
      timeoutMs: 5_000,
    });
    if (defaults.code === 0) {
      try {
        currentAudioDefaults = JSON.parse(defaults.stdout ?? "") as DefaultAudioDevices;
        const problem = findPhysicalOutputProblem(currentAudioDefaults);
        pushCheck(checks, {
          id: "physical-output",
          label: "Physical call output",
          ok: !problem,
          message: problem ?? currentAudioDefaults.output.name,
        });
      } catch (error) {
        currentAudioError = `invalid audio-device JSON: ${formatErrorMessage(error)}`;
      }
    } else {
      currentAudioError = firstLine(defaults.stderr) ?? firstLine(defaults.stdout);
    }
    if (currentAudioError) {
      pushCheck(checks, {
        id: "physical-output",
        label: "Physical call output",
        ok: false,
        message: currentAudioError,
      });
    }

    const capture = await runCommandWithTimeout([params.captureBinary, "--check"], {
      timeoutMs: 8_000,
    });
    pushCheck(checks, {
      id: "process-tap",
      label: "FaceTime app-audio process tap",
      ok: capture.code === 0,
      message:
        firstLine(capture.stderr) ??
        firstLine(capture.stdout) ??
        "grant Screen & System Audio Recording permission",
    });
  } else {
    pushCheck(checks, {
      id: "physical-output",
      label: "Physical call output",
      ok: false,
      message: "capture helper unavailable",
    });
    pushCheck(checks, {
      id: "process-tap",
      label: "FaceTime app-audio process tap",
      ok: false,
      message: "capture helper unavailable",
    });
  }

  await checkPairedDriverLoopback({ runCommandWithTimeout, checks });

  const providerCredentialReady = await hasProviderCredential({
    config: params.config,
    fullConfig: params.fullConfig,
  });
  pushCheck(checks, {
    id: "realtime-provider",
    label: "Realtime provider credentials",
    ok: providerCredentialReady,
    message: `${params.config.realtime.provider}:${params.config.realtime.model}`,
  });

  return {
    ok: checks.every((check) => check.ok || !check.required),
    helperConnected: params.helperConnected,
    currentAudioDefaults,
    currentAudioError,
    checks,
  };
}
