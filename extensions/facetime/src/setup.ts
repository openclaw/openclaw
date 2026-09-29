import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { FaceTimeConfig } from "./config.js";
import { inspectFaceTimeDriver } from "./driver-setup.js";
import type { FaceTimePreflightCheck, FaceTimePreflightResult } from "./preflight.js";
import type { FaceTimeRuntimeStatus } from "./runtime-state.js";

type RunCommandWithTimeout = PluginRuntime["system"]["runCommandWithTimeout"];
type FaceTimeSetupCheckStatus = "ready" | "action-required" | "verify-on-call";
type FaceTimeSetupAction = {
  id: string;
  kind: "command" | "gateway" | "system-settings" | "manual-test";
  label: string;
  command?: string;
  gatewayMethod?: string;
  settingsPath?: string;
};
type FaceTimeSetupCheck = {
  id: string;
  label: string;
  status: FaceTimeSetupCheckStatus;
  required: boolean;
  message: string;
  actionId?: string;
};
export type FaceTimeSetupReport = {
  ok: boolean;
  readyForTest: boolean;
  liveCallProofRequired: boolean;
  controlMode: "operator-assisted";
  checks: FaceTimeSetupCheck[];
  actions: FaceTimeSetupAction[];
};

type SetupParams = {
  config: FaceTimeConfig;
  nativePackageReady: boolean;
  pluginRoot: string;
  runCommandWithTimeout: RunCommandWithTimeout;
  runtimeStatus?: FaceTimeRuntimeStatus | Promise<FaceTimeRuntimeStatus>;
  runtimeError?: string;
  preflight?: FaceTimePreflightResult | Promise<FaceTimePreflightResult>;
};

const NATIVE_PACKAGE_ACTION = {
  id: "install-native-package",
  kind: "command",
  label: "Install or reinstall the FaceTime audio capture package",
  command:
    "if brew list --versions openclaw-facetime >/dev/null 2>&1; then brew reinstall openclaw/tap/openclaw-facetime; else brew install openclaw/tap/openclaw-facetime; fi",
} as const satisfies FaceTimeSetupAction;

const ACTIONS: Record<string, FaceTimeSetupAction> = {
  "capture-binary": NATIVE_PACKAGE_ACTION,
  "call-app-running": {
    id: "open-facetime",
    kind: "command",
    label: "Open FaceTime",
    command: "open -a FaceTime",
  },
  "paired-driver-mic": {
    id: "install-driver",
    kind: "gateway",
    label: "Install or update the paired FaceTime audio driver",
    gatewayMethod: "facetime.installDriver",
  },
  "paired-driver-feed": {
    id: "install-driver",
    kind: "gateway",
    label: "Install or update the paired FaceTime audio driver",
    gatewayMethod: "facetime.installDriver",
  },
  "physical-output": {
    id: "select-physical-output",
    kind: "system-settings",
    label: "Select a physical audio output",
    settingsPath: "System Settings > Sound > Output",
  },
  "process-tap": {
    id: "grant-system-audio",
    kind: "system-settings",
    label: "Allow OpenClaw to capture FaceTime app audio",
    settingsPath: "System Settings > Privacy & Security > Screen & System Audio Recording",
  },
  "realtime-provider": {
    id: "configure-realtime-provider",
    kind: "command",
    label: "Configure a realtime voice provider",
    command: "openclaw configure",
  },
};

function addAction(actions: FaceTimeSetupAction[], action: FaceTimeSetupAction) {
  if (!actions.some((candidate) => candidate.id === action.id)) {
    actions.push(action);
  }
}

function projectPreflightCheck(
  check: FaceTimePreflightCheck,
  actions: FaceTimeSetupAction[],
): FaceTimeSetupCheck {
  const action = ACTIONS[check.id];
  if (!check.ok && action) {
    addAction(actions, action);
  }
  return {
    id: check.id,
    label: check.label,
    status: check.ok ? "ready" : check.required ? "action-required" : "verify-on-call",
    required: check.required,
    message: check.message ?? (check.ok ? "ready" : "not ready"),
    ...(!check.ok && action ? { actionId: action.id } : {}),
  };
}

export async function runFaceTimeSetup(params: SetupParams): Promise<FaceTimeSetupReport> {
  const checks: FaceTimeSetupCheck[] = [];
  const actions: FaceTimeSetupAction[] = [];
  checks.push({
    id: "supported-control-mode",
    label: "FaceTime control architecture",
    status: "ready",
    required: true,
    message:
      "Operator-assisted out-of-process bridge; SIP changes, debugger access, and injected dylibs are not used",
  });
  checks.push({
    id: "owner-handles",
    label: "Owner FaceTime handles",
    status: params.config.ownerHandles.length > 0 ? "ready" : "action-required",
    required: true,
    message:
      params.config.ownerHandles.length > 0
        ? `${params.config.ownerHandles.length} owner handle${params.config.ownerHandles.length === 1 ? "" : "s"} configured`
        : "Configure at least one owner email address or phone number",
    ...(params.config.ownerHandles.length === 0 ? { actionId: "configure-owner-handles" } : {}),
  });
  if (params.config.ownerHandles.length === 0) {
    addAction(actions, {
      id: "configure-owner-handles",
      kind: "command",
      label: "Configure ownerHandles",
      command: "openclaw configure",
    });
  }
  checks.push({
    id: "native-package",
    label: "FaceTime audio capture package",
    status: params.nativePackageReady ? "ready" : "action-required",
    required: true,
    message: params.nativePackageReady
      ? "Compatible out-of-process capture binary is installed"
      : "FaceTime audio capture is not installed",
    ...(!params.nativePackageReady ? { actionId: NATIVE_PACKAGE_ACTION.id } : {}),
  });
  if (!params.nativePackageReady) {
    addAction(actions, NATIVE_PACKAGE_ACTION);
  }

  const runtimeStatus = params.runtimeStatus ? await params.runtimeStatus : undefined;
  checks.push({
    id: "runtime",
    label: "FaceTime plugin runtime",
    status: runtimeStatus ? "ready" : "action-required",
    required: true,
    message: runtimeStatus
      ? "Operator-assisted runtime is active"
      : (params.runtimeError ?? "FaceTime runtime is not running"),
  });

  let driverStatus: string | undefined;
  if (params.nativePackageReady) {
    try {
      driverStatus = await inspectFaceTimeDriver({
        pluginRoot: params.pluginRoot,
        runCommandWithTimeout: params.runCommandWithTimeout,
      });
    } catch (error) {
      driverStatus = `error: ${formatErrorMessage(error)}`;
    }
  }
  const driverReady = driverStatus === "current";
  checks.push({
    id: "audio-driver",
    label: "Paired FaceTime audio driver",
    status: driverReady ? "ready" : "action-required",
    required: true,
    message: driverReady
      ? "OpenClaw-Mic and OpenClaw-Feed are current"
      : `Driver status: ${driverStatus ?? "unavailable"}`,
    ...(!driverReady ? { actionId: "install-driver" } : {}),
  });
  if (!driverReady) {
    addAction(actions, ACTIONS["paired-driver-mic"]!);
  }

  if (params.preflight) {
    const preflight = await params.preflight;
    checks.push(...preflight.checks.map((check) => projectPreflightCheck(check, actions)));
  }

  checks.push({
    id: "operator-attachment",
    label: "Live FaceTime attachment",
    status: runtimeStatus?.calls.length ? "ready" : "verify-on-call",
    required: false,
    message: runtimeStatus?.calls.length
      ? "OpenClaw is attached to the one active FaceTime media owner"
      : "Answer or confirm a FaceTime call, then approve attach_current_call",
    ...(runtimeStatus?.calls.length ? {} : { actionId: "attach-live-call" }),
  });
  if (!runtimeStatus?.calls.length) {
    addAction(actions, {
      id: "attach-live-call",
      kind: "manual-test",
      label: "Answer or confirm a FaceTime call, then attach OpenClaw",
      gatewayMethod: "facetime.attach",
    });
  }
  const requiredReady = checks.every((check) => !check.required || check.status === "ready");
  return {
    ok: requiredReady,
    readyForTest: requiredReady,
    liveCallProofRequired: true,
    controlMode: "operator-assisted",
    checks,
    actions,
  };
}
