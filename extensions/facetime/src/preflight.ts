import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { asRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { FACETIME_FEED_DEVICE_NAME, FACETIME_MIC_DEVICE_NAME } from "./audio-pump.js";
import type { FaceTimeConfig } from "./config.js";
import { agentIdFromSessionKey, resolveFaceTimeRealtimeProvider } from "./talk-driver-config.js";

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

type CoreAudioDeviceProfile = {
  name: string;
  virtual: boolean;
};

function parseDefaultAudioDevices(raw: string): DefaultAudioDevices {
  const parsed: unknown = JSON.parse(raw);
  const record = asRecord(parsed);
  const input = asRecord(record.input);
  const output = asRecord(record.output);
  if (
    typeof input.isAggregate !== "boolean" ||
    typeof input.name !== "string" ||
    typeof input.uid !== "string" ||
    typeof output.isAggregate !== "boolean" ||
    typeof output.name !== "string" ||
    typeof output.uid !== "string"
  ) {
    throw new Error("invalid audio-device shape");
  }
  return {
    input: { isAggregate: input.isAggregate, name: input.name, uid: input.uid },
    output: { isAggregate: output.isAggregate, name: output.name, uid: output.uid },
  };
}

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
  return typeof value === "string" ? value.trim().split(/\r?\n/u)[0] || undefined : undefined;
}

function pushCheck(
  checks: FaceTimePreflightCheck[],
  check: Omit<FaceTimePreflightCheck, "required"> & { required?: boolean },
) {
  checks.push({ required: true, ...check });
}

function parseCoreAudioDevices(systemProfilerOutput: string): CoreAudioDeviceProfile[] {
  try {
    const parsed = asRecord(JSON.parse(systemProfilerOutput));
    const entries = Array.isArray(parsed.SPAudioDataType) ? parsed.SPAudioDataType : [];
    const deviceEntries = entries.flatMap((entry): unknown[] => {
      const record = asRecord(entry);
      const items = record["_items"];
      return Array.isArray(items) ? items : [record];
    });
    const devices = deviceEntries.flatMap((entry): CoreAudioDeviceProfile[] => {
      const record = asRecord(entry);
      const name = record["_name"];
      return typeof name === "string"
        ? [
            {
              name,
              virtual: record.coreaudio_device_transport === "coreaudio_device_type_virtual",
            },
          ]
        : [];
    });
    if (devices.length > 0) {
      return devices;
    }
  } catch {
    // Older test fixtures and unusual system_profiler failures can still
    // provide the human-readable device list without transport metadata.
  }
  const devices: CoreAudioDeviceProfile[] = [];
  for (const line of systemProfilerOutput.split(/\r?\n/u)) {
    const match = line.match(/^\s{8}(.+):\s*$/u);
    if (match?.[1]) {
      devices.push({ name: match[1].trim(), virtual: false });
    }
  }
  return [...new Map(devices.map((device) => [device.name, device])).values()];
}

function findPhysicalOutputProblem(
  defaults: DefaultAudioDevices,
  devices: readonly CoreAudioDeviceProfile[],
): string | undefined {
  if (defaults.output.isAggregate) {
    return `system output is aggregate device ${defaults.output.name}`;
  }
  if (
    devices.some((device) => device.name === defaults.output.name && device.virtual) ||
    /BlackHole|OpenClaw-(?:Feed|Mic)/iu.test(defaults.output.name)
  ) {
    return `system output is virtual device ${defaults.output.name}`;
  }
  return undefined;
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
      : "no authenticated helper connected on the local UID-derived endpoint",
  });

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
        : "capture helper is missing; reinstall with brew install openclaw/tap/openclaw-facetime",
  });

  await checkCallApp({ runCommandWithTimeout, checks });

  const profiler = await runCommandWithTimeout(
    ["/usr/sbin/system_profiler", "SPAudioDataType", "-json"],
    { timeoutMs: 10_000 },
  );
  const audioDevices = profiler.code === 0 ? parseCoreAudioDevices(profiler.stdout ?? "") : [];
  const deviceNames = new Set(audioDevices.map((device) => device.name));
  for (const [id, label, deviceName] of [
    ["paired-driver-mic", "OpenClaw microphone device", FACETIME_MIC_DEVICE_NAME],
    ["paired-driver-feed", "OpenClaw feed device", FACETIME_FEED_DEVICE_NAME],
  ] as const) {
    const found = deviceNames.has(deviceName);
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
        currentAudioDefaults = parseDefaultAudioDevices(defaults.stdout ?? "");
        const problem = findPhysicalOutputProblem(currentAudioDefaults, audioDevices);
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

  let providerReady = false;
  let providerMessage: string;
  try {
    const resolved = await resolveFaceTimeRealtimeProvider({
      config: params.config,
      fullConfig: params.fullConfig,
      agentId: agentIdFromSessionKey(params.config.realtime.sessionKey, params.fullConfig),
    });
    providerReady = true;
    providerMessage = `${resolved.provider.id}:${normalizeOptionalString(resolved.providerConfig.model) ?? "provider default"}`;
  } catch (error) {
    providerMessage = formatErrorMessage(error);
  }
  pushCheck(checks, {
    id: "realtime-provider",
    label: "Realtime provider readiness",
    ok: providerReady,
    message: providerMessage,
  });

  return {
    ok: checks.every((check) => check.ok || !check.required),
    helperConnected: params.helperConnected,
    currentAudioDefaults,
    currentAudioError,
    checks,
  };
}
