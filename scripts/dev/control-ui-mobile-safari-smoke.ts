import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  redactControlUiSmokeSecrets,
  resolveControlUiSmokeUrl,
  type ControlUiSmokeUrl,
} from "./control-ui-smoke-url.js";

type CommandResult = {
  command: string[];
  ok: boolean;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
};

type DeviceTarget = {
  id: string;
  name: string;
};

type SmokeSummary = {
  ok: boolean;
  url: string;
  launchUrl: string;
  auth: ControlUiSmokeUrl["auth"];
  artifactDir: string;
  physical: {
    available: boolean;
    required: boolean;
    devices: DeviceTarget[];
    launched: boolean;
    launchableUrl: boolean;
    urlReachability?: string;
    launch?: CommandResult;
    reason?: string;
    nextSteps: string[];
  };
  simulator: {
    enabled: boolean;
    available: boolean;
    target?: DeviceTarget;
    opened: boolean;
    screenshot?: string;
    launch?: CommandResult;
    open?: CommandResult;
    screenshotResult?: CommandResult;
    reason?: string;
  };
};

type CliOptions = {
  requirePhysical?: boolean;
  simulatorEnabled?: boolean;
};

function run(command: string, args: string[], timeoutMs = 30_000): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 8,
  });
  return {
    command: [command, ...args].map((part) => redactSmokeSecrets(part)),
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: redactSmokeSecrets(result.stdout ?? ""),
    stderr: redactSmokeSecrets(result.stderr ?? ""),
    error: result.error ? result.error.message : undefined,
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function nestedString(record: Record<string, unknown>, keys: string[]): string | undefined {
  let current: unknown = record;
  for (const key of keys) {
    const next = objectRecord(current)?.[key];
    if (next === undefined) {
      return undefined;
    }
    current = next;
  }
  return stringValue(current);
}

function deviceId(device: Record<string, unknown>): string | undefined {
  return (
    stringValue(device.identifier) ??
    stringValue(device.udid) ??
    stringValue(device.UDID) ??
    stringValue(device.id) ??
    nestedString(device, ["deviceProperties", "udid"]) ??
    nestedString(device, ["deviceProperties", "identifier"])
  );
}

function deviceName(device: Record<string, unknown>, fallbackId: string): string {
  return (
    stringValue(device.name) ??
    stringValue(device.deviceName) ??
    nestedString(device, ["deviceProperties", "name"]) ??
    fallbackId
  );
}

function physicalDevices(json: unknown): DeviceTarget[] {
  const result = objectRecord(json)?.result;
  const devices = objectRecord(result)?.devices;
  if (!Array.isArray(devices)) {
    return [];
  }
  return devices
    .map((device) => objectRecord(device))
    .filter((device): device is Record<string, unknown> => device !== null)
    .map((device) => {
      const id = deviceId(device);
      return id ? { id, name: deviceName(device, id) } : null;
    })
    .filter((device): device is DeviceTarget => device !== null);
}

function bootedIphoneSimulator(json: unknown): DeviceTarget | undefined {
  const devicesByRuntime = objectRecord(objectRecord(json)?.devices);
  if (!devicesByRuntime) {
    return undefined;
  }
  for (const devices of Object.values(devicesByRuntime)) {
    if (!Array.isArray(devices)) {
      continue;
    }
    for (const rawDevice of devices) {
      const device = objectRecord(rawDevice);
      if (!device) {
        continue;
      }
      const state = stringValue(device.state);
      const name = stringValue(device.name);
      const type = stringValue(device.deviceTypeIdentifier);
      const id = stringValue(device.udid);
      const isIphone =
        (name?.toLowerCase().includes("iphone") ?? false) ||
        (type?.toLowerCase().includes("iphone") ?? false);
      if (state === "Booted" && isIphone && id) {
        return { id, name: name ?? id };
      }
    }
  }
  return undefined;
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function redactSmokeSecrets(value: string): string {
  return redactControlUiSmokeSecrets(value);
}

export function toChatUrl(launchUrl: string): string {
  const chatUrl = new URL(launchUrl);
  const routeBase = chatUrl.pathname.replace(/\/$/, "");
  if (!/\/chat$/i.test(routeBase)) {
    chatUrl.pathname = `${routeBase === "" ? "" : routeBase}/chat`;
  }
  chatUrl.searchParams.set("__openclaw_mobile_rescue", String(Date.now()));
  return chatUrl.toString();
}

export function isPhysicalDeviceReachableUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      hostname !== "localhost" &&
      hostname !== "0.0.0.0" &&
      hostname !== "::1" &&
      !hostname.startsWith("127.")
    );
  } catch {
    return false;
  }
}

async function resolveDashboardUrl(): Promise<ControlUiSmokeUrl> {
  return resolveControlUiSmokeUrl({
    explicitUrlEnvNames: [
      "OPENCLAW_CONTROL_UI_MOBILE_SAFARI_URL",
      "OPENCLAW_CONTROL_UI_MOBILE_CHAT_URL",
      "OPENCLAW_CONTROL_UI_SMOKE_URL",
    ],
  });
}

function isEnabled(value: string | undefined, defaultValue: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(normalized);
}

function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (const arg of argv) {
    switch (arg) {
      case "--physical":
      case "--require-physical":
        options.requirePhysical = true;
        break;
      case "--no-require-physical":
        options.requirePhysical = false;
        break;
      case "--allow-simulator":
      case "--simulator":
        options.simulatorEnabled = true;
        break;
      case "--no-simulator":
        options.simulatorEnabled = false;
        break;
      default:
        throw new Error(
          `Unknown argument ${arg}. Supported flags: --require-physical, --no-require-physical, --simulator, --no-simulator.`,
        );
    }
  }
  return options;
}

function physicalDeviceNextSteps(params: {
  devicesVisible: boolean;
  launchFailed: boolean;
  launchableUrl: boolean;
}): string[] {
  const urlSteps = params.launchableUrl
    ? []
    : [
        "Use a phone-reachable Gateway URL such as OPENCLAW_CONTROL_UI_MOBILE_SAFARI_URL=https://openclaw.tail6ec0db.ts.net/ instead of 127.0.0.1 or localhost.",
      ];
  if (params.devicesVisible && !params.launchFailed) {
    return urlSteps;
  }
  if (params.launchFailed) {
    return [
      ...urlSteps,
      "Unlock the iPhone and keep it awake during the smoke run.",
      "Confirm Mobile Safari can launch normally on the iPhone.",
      "Confirm the iPhone remains trusted in Finder or Xcode Devices and Simulators.",
      "Rerun the physical-only smoke with pnpm ui:smoke:mobile-safari:physical.",
    ];
  }
  return [
    ...urlSteps,
    "Connect the iPhone to this Mac over USB, or pair it for wireless development.",
    "Unlock the iPhone and tap Trust This Computer if prompted.",
    "Enable Developer Mode on the iPhone if iOS requires it, then restart and unlock the phone.",
    "Confirm the iPhone appears in Finder or Xcode Devices and Simulators.",
    "Rerun the physical-only smoke with pnpm ui:smoke:mobile-safari:physical.",
  ];
}

async function main() {
  const cliOptions = parseCliOptions(process.argv.slice(2));
  const smokeUrl = await resolveDashboardUrl();
  const chatUrl = toChatUrl(smokeUrl.launchUrl);
  const physicalLaunchableUrl = isPhysicalDeviceReachableUrl(chatUrl);
  const artifactDir =
    process.env.OPENCLAW_CONTROL_UI_MOBILE_SAFARI_ARTIFACT_DIR?.trim() ||
    join(".artifacts", "control-ui-mobile-safari", timestampSlug());
  mkdirSync(artifactDir, { recursive: true });

  const physicalJsonPath = join(artifactDir, "physical-devices.json");
  const physicalList = run(
    "xcrun",
    ["devicectl", "list", "devices", "--json-output", physicalJsonPath],
    30_000,
  );
  const devices = physicalList.ok ? physicalDevices(readJsonFile(physicalJsonPath)) : [];
  const requirePhysical =
    cliOptions.requirePhysical ??
    isEnabled(process.env.OPENCLAW_CONTROL_UI_MOBILE_SAFARI_REQUIRE_PHYSICAL, false);
  const simulatorEnabled =
    cliOptions.simulatorEnabled ??
    isEnabled(process.env.OPENCLAW_CONTROL_UI_MOBILE_SAFARI_SIMULATOR, true);

  const summary: SmokeSummary = {
    ok: false,
    url: smokeUrl.displayUrl,
    launchUrl: redactSmokeSecrets(chatUrl),
    auth: smokeUrl.auth,
    artifactDir,
    physical: {
      available: devices.length > 0,
      required: requirePhysical,
      devices,
      launched: false,
      launchableUrl: physicalLaunchableUrl,
      urlReachability: physicalLaunchableUrl
        ? "Phone-reachable URL."
        : "Physical iPhone validation requires a phone-reachable URL, not localhost or 127.0.0.1.",
      reason:
        devices.length > 0
          ? physicalLaunchableUrl
            ? undefined
            : "Physical iPhone URL is not reachable from the phone."
          : physicalList.ok
            ? "No physical iPhone is visible to CoreDevice."
            : "CoreDevice device listing failed.",
      nextSteps: physicalDeviceNextSteps({
        devicesVisible: devices.length > 0,
        launchFailed: false,
        launchableUrl: physicalLaunchableUrl,
      }),
    },
    simulator: {
      enabled: simulatorEnabled,
      available: false,
      opened: false,
      reason: simulatorEnabled ? undefined : "Simulator fallback disabled by environment.",
    },
  };

  if (devices.length > 0 && physicalLaunchableUrl) {
    const target = devices[0];
    const launchPath = join(artifactDir, "physical-launch.json");
    const launch = run(
      "xcrun",
      [
        "devicectl",
        "device",
        "process",
        "launch",
        "--device",
        target.id,
        "com.apple.mobilesafari",
        "--payload-url",
        chatUrl,
        "--terminate-existing",
        "--json-output",
        launchPath,
      ],
      45_000,
    );
    summary.physical.launch = launch;
    summary.physical.launched = launch.ok;
    summary.physical.reason = launch.ok
      ? undefined
      : "Physical iPhone was visible, but Mobile Safari launch failed.";
    summary.physical.nextSteps = physicalDeviceNextSteps({
      devicesVisible: true,
      launchFailed: !launch.ok,
      launchableUrl: physicalLaunchableUrl,
    });
  }

  if (simulatorEnabled) {
    const simulatorJsonPath = join(artifactDir, "booted-simulators.json");
    const listSimulators = run("xcrun", ["simctl", "list", "devices", "booted", "--json"], 30_000);
    writeFileSync(simulatorJsonPath, listSimulators.stdout);
    const simulator = listSimulators.ok
      ? bootedIphoneSimulator(readJsonFile(simulatorJsonPath))
      : undefined;
    summary.simulator.available = simulator !== undefined;
    summary.simulator.target = simulator;
    if (simulator) {
      const launch = run(
        "xcrun",
        ["simctl", "launch", "--terminate-running-process", simulator.id, "com.apple.mobilesafari"],
        30_000,
      );
      summary.simulator.launch = launch;
      await delay(1_200);
      const open = run("xcrun", ["simctl", "openurl", simulator.id, chatUrl], 30_000);
      summary.simulator.open = open;
      summary.simulator.opened = open.ok;
      if (open.ok) {
        await delay(4_000);
        const screenshot = join(artifactDir, "simulator-safari-open.png");
        const screenshotResult = run(
          "xcrun",
          ["simctl", "io", simulator.id, "screenshot", screenshot],
          30_000,
        );
        summary.simulator.screenshotResult = screenshotResult;
        summary.simulator.screenshot = screenshotResult.ok ? screenshot : undefined;
        summary.simulator.reason = screenshotResult.ok
          ? undefined
          : "Simulator opened Mobile Safari, but screenshot capture failed.";
      } else {
        summary.simulator.reason =
          "Booted iPhone simulator was visible, but Mobile Safari openurl failed.";
      }
    } else if (!listSimulators.ok) {
      summary.simulator.reason = "Could not list booted iPhone simulators.";
    } else {
      summary.simulator.reason = "No booted iPhone simulator is available.";
    }
  }

  summary.ok =
    summary.physical.launched ||
    (!requirePhysical && summary.simulator.opened && summary.simulator.screenshot !== undefined);

  writeFileSync(join(artifactDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

  if (!summary.ok) {
    console.error(`control-ui-mobile-safari-smoke: failed ${JSON.stringify(summary, null, 2)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`control-ui-mobile-safari-smoke: ok ${JSON.stringify(summary, null, 2)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
