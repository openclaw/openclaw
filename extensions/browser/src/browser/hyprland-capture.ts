import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HYPRCTL_TIMEOUT_MS = 1500;
const OUTPUT_WAIT_TIMEOUT_MS = 3000;
const CLIENT_WAIT_TIMEOUT_MS = 5000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 2000;
const DEFAULT_OUTPUT_WIDTH = 1920;
const DEFAULT_OUTPUT_HEIGHT = 1080;
const DEFAULT_OUTPUT_REFRESH_HZ = 60;
const TRUSTED_BIN_DIRS = [
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/run/current-system/sw/bin",
  "/usr/local/bin",
  "/snap/bin",
] as const;

type HyprlandInstanceRecord = {
  instance?: unknown;
  time?: unknown;
  wl_socket?: unknown;
};

type HyprlandWorkspace = {
  id?: unknown;
  name?: unknown;
};

type HyprlandMonitor = {
  name?: unknown;
  width?: unknown;
  height?: unknown;
  refreshRate?: unknown;
  x?: unknown;
  y?: unknown;
  scale?: unknown;
  activeWorkspace?: HyprlandWorkspace;
};

type HyprlandClient = {
  pid?: unknown;
  workspace?: HyprlandWorkspace;
};

export type HyprlandSession = {
  signature: string;
  wlSocket: string;
  runtimeDir: string;
};

export type HeadedBrowserViewportCapture = {
  kind: "hyprland-grim";
  outputName: string;
  width: number;
  height: number;
  refreshHz: number;
  session: HyprlandSession;
};

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value ?? 0);
}

function toString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveRuntimeDir(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDir) {
    return runtimeDir;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
  return path.join("/run/user", String(uid));
}

function hyprlandEnv(session: HyprlandSession): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_RUNTIME_DIR: session.runtimeDir,
    WAYLAND_DISPLAY: session.wlSocket,
    HYPRLAND_INSTANCE_SIGNATURE: session.signature,
  };
}

function resolveTrustedBinary(name: string): string | null {
  for (const dir of TRUSTED_BIN_DIRS) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

function resolveHyprctlPath(): string {
  const hyprctl = resolveTrustedBinary("hyprctl");
  if (!hyprctl) {
    throw new Error("hyprctl not found");
  }
  return hyprctl;
}

function resolveGrimPath(): string {
  const grim = resolveTrustedBinary("grim");
  if (!grim) {
    throw new Error("grim not found");
  }
  return grim;
}

async function execText(
  command: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<string> {
  const result = await new Promise<{ stdout: string | Buffer; stderr: string | Buffer }>(
    (resolve, reject) => {
      execFile(
        command,
        args,
        {
          env: opts.env,
          timeout: opts.timeoutMs ?? HYPRCTL_TIMEOUT_MS,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (err) {
            reject(err);
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    },
  );
  return typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf8");
}

async function execBuffer(
  command: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<Buffer> {
  const result = await new Promise<{ stdout: string | Buffer; stderr: string | Buffer }>(
    (resolve, reject) => {
      execFile(
        command,
        args,
        {
          env: opts.env,
          timeout: opts.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS,
          encoding: "buffer",
          maxBuffer: 64 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (err) {
            reject(err);
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    },
  );
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
}

async function runHyprctlText(
  session: HyprlandSession,
  args: string[],
  timeoutMs = HYPRCTL_TIMEOUT_MS,
): Promise<string> {
  return await execText(resolveHyprctlPath(), ["-i", session.signature, ...args], {
    env: hyprlandEnv(session),
    timeoutMs,
  });
}

async function runHyprctlJson<T>(session: HyprlandSession, args: string[]): Promise<T> {
  const raw = await execText(resolveHyprctlPath(), ["-j", "-i", session.signature, ...args], {
    env: hyprlandEnv(session),
  });
  return JSON.parse(raw) as T;
}

async function waitFor<T>(
  timeoutMs: number,
  pollMs: number,
  fn: () => Promise<T | null>,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}

function findMonitorByName(
  monitors: HyprlandMonitor[],
  outputName: string,
): HyprlandMonitor | null {
  return monitors.find((monitor) => toString(monitor.name) === outputName) ?? null;
}

function findClientByPid(clients: HyprlandClient[], pid: number): HyprlandClient | null {
  return clients.find((client) => toNumber(client.pid) === pid) ?? null;
}

function monitorNeedsRefresh(monitor: HyprlandMonitor): boolean {
  return (
    Math.floor(toNumber(monitor.width)) !== DEFAULT_OUTPUT_WIDTH ||
    Math.floor(toNumber(monitor.height)) !== DEFAULT_OUTPUT_HEIGHT ||
    Math.abs(toNumber(monitor.refreshRate) - DEFAULT_OUTPUT_REFRESH_HZ) > 0.5 ||
    Math.abs(toNumber(monitor.scale) - 1) > 0.01
  );
}

function monitorConfig(monitor: HyprlandMonitor, outputName: string): string {
  const x = Math.floor(toNumber(monitor.x));
  const y = Math.floor(toNumber(monitor.y));
  return `${outputName},${DEFAULT_OUTPUT_WIDTH}x${DEFAULT_OUTPUT_HEIGHT}@${DEFAULT_OUTPUT_REFRESH_HZ},${x}x${y},1`;
}

function workspaceSelector(monitor: HyprlandMonitor): string {
  const workspaceId = Math.floor(toNumber(monitor.activeWorkspace?.id));
  if (workspaceId > 0) {
    return String(workspaceId);
  }
  const workspaceName = toString(monitor.activeWorkspace?.name);
  if (!workspaceName) {
    throw new Error("Hyprland output has no active workspace");
  }
  return workspaceName.startsWith("name:") ? workspaceName : `name:${workspaceName}`;
}

function pickHyprlandInstance(records: HyprlandInstanceRecord[]): HyprlandInstanceRecord | null {
  if (!records.length) {
    return null;
  }
  const preferred = process.env.HYPRLAND_INSTANCE_SIGNATURE?.trim();
  if (preferred) {
    const match = records.find((record) => toString(record.instance) === preferred);
    if (match) {
      return match;
    }
  }
  return records.toSorted((a, b) => toNumber(b.time) - toNumber(a.time))[0] ?? null;
}

function isUsableSession(session: HyprlandSession): boolean {
  if (!session.signature || !session.wlSocket || !session.runtimeDir) {
    return false;
  }
  const socketPath = path.join(session.runtimeDir, "hypr", session.signature, ".socket.sock");
  return fs.existsSync(socketPath);
}

export async function detectHyprlandSession(): Promise<HyprlandSession | null> {
  const runtimeDir = resolveRuntimeDir();
  let records: HyprlandInstanceRecord[];
  try {
    const raw = await execText(resolveHyprctlPath(), ["-j", "instances"], {
      timeoutMs: HYPRCTL_TIMEOUT_MS,
    });
    records = JSON.parse(raw) as HyprlandInstanceRecord[];
  } catch {
    return null;
  }

  const picked = pickHyprlandInstance(records);
  if (!picked) {
    return null;
  }

  const session = {
    signature: toString(picked.instance),
    wlSocket: toString(picked.wl_socket),
    runtimeDir,
  };
  return isUsableSession(session) ? session : null;
}

async function ensureCaptureOutput(
  session: HyprlandSession,
  outputName: string,
): Promise<HyprlandMonitor> {
  let monitor = findMonitorByName(
    await runHyprctlJson<HyprlandMonitor[]>(session, ["monitors", "all"]),
    outputName,
  );

  if (!monitor) {
    await runHyprctlText(session, ["output", "create", "headless", outputName]);
    monitor = await waitFor(OUTPUT_WAIT_TIMEOUT_MS, 100, async () => {
      return findMonitorByName(
        await runHyprctlJson<HyprlandMonitor[]>(session, ["monitors", "all"]),
        outputName,
      );
    });
    if (!monitor) {
      throw new Error(`Hyprland output "${outputName}" did not appear`);
    }
  }

  if (monitorNeedsRefresh(monitor)) {
    await runHyprctlText(session, ["keyword", "monitor", monitorConfig(monitor, outputName)]);
    const refreshed = await waitFor(OUTPUT_WAIT_TIMEOUT_MS, 100, async () => {
      return findMonitorByName(
        await runHyprctlJson<HyprlandMonitor[]>(session, ["monitors", "all"]),
        outputName,
      );
    });
    if (refreshed) {
      monitor = refreshed;
    }
  }

  return monitor;
}

async function waitForClientForPid(
  session: HyprlandSession,
  browserPid: number,
): Promise<HyprlandClient | null> {
  return await waitFor(CLIENT_WAIT_TIMEOUT_MS, 100, async () => {
    return findClientByPid(
      await runHyprctlJson<HyprlandClient[]>(session, ["clients"]),
      browserPid,
    );
  });
}

export async function setupHeadedBrowserViewportCapture(params: {
  browserPid: number;
  session: HyprlandSession;
  outputName?: string;
}): Promise<HeadedBrowserViewportCapture> {
  const outputName = params.outputName?.trim() || "browser-capture";
  const monitor = await ensureCaptureOutput(params.session, outputName);
  const workspace = workspaceSelector(monitor);

  if (!(await waitForClientForPid(params.session, params.browserPid))) {
    throw new Error(`Browser window for pid ${params.browserPid} did not appear in Hyprland`);
  }

  await runHyprctlText(params.session, [
    "dispatch",
    "movetoworkspacesilent",
    `${workspace},pid:${params.browserPid}`,
  ]);

  const moved = await waitFor(CLIENT_WAIT_TIMEOUT_MS, 100, async () => {
    const client = findClientByPid(
      await runHyprctlJson<HyprlandClient[]>(params.session, ["clients"]),
      params.browserPid,
    );
    if (!client) {
      return null;
    }
    return toNumber(client.workspace?.id) === toNumber(monitor.activeWorkspace?.id) ? client : null;
  });

  if (!moved) {
    throw new Error(`Browser window for pid ${params.browserPid} did not move to "${outputName}"`);
  }

  return {
    kind: "hyprland-grim",
    outputName,
    width: DEFAULT_OUTPUT_WIDTH,
    height: DEFAULT_OUTPUT_HEIGHT,
    refreshHz: DEFAULT_OUTPUT_REFRESH_HZ,
    session: params.session,
  };
}

export async function captureViewportPng(params: {
  capture: HeadedBrowserViewportCapture;
  timeoutMs?: number;
}): Promise<Buffer> {
  await ensureCaptureOutput(params.capture.session, params.capture.outputName);
  const grim = resolveGrimPath();
  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? Math.max(250, Math.min(10000, Math.floor(params.timeoutMs)))
      : DEFAULT_CAPTURE_TIMEOUT_MS;

  const png = await execBuffer(grim, ["-o", params.capture.outputName, "-l", "0", "-"], {
    env: hyprlandEnv(params.capture.session),
    timeoutMs,
  });

  if (!png.byteLength) {
    throw new Error(`grim returned an empty screenshot for "${params.capture.outputName}"`);
  }

  return png;
}

export async function teardownHeadedBrowserViewportCapture(
  capture: HeadedBrowserViewportCapture,
): Promise<void> {
  await runHyprctlText(capture.session, ["output", "remove", capture.outputName]).catch(() => {});
}

// ── Singleton session cache ─────────────────────────────────────────────
let cachedCapture: HeadedBrowserViewportCapture | null = null;
let cachedPid: number | null = null;
let setupLock: Promise<void> | null = null;

export async function tryHyprlandViewportCapture(params: {
  browserPid: number;
  timeoutMs?: number;
}): Promise<Buffer | null> {
  if (process.platform !== "linux") {
    return null;
  }
  // Serialize setup to prevent concurrent callers from racing
  let lock = setupLock;
  while (lock) {
    await lock;
    lock = setupLock;
  }
  try {
    if (cachedCapture && cachedPid !== params.browserPid) {
      await teardownHeadedBrowserViewportCapture(cachedCapture).catch(() => {});
      cachedCapture = null;
      cachedPid = null;
    }
    if (!cachedCapture) {
      let resolve!: () => void;
      setupLock = new Promise<void>((r) => {
        resolve = r;
      });
      try {
        const session = await detectHyprlandSession();
        if (!session) {
          return null;
        }
        cachedCapture = await setupHeadedBrowserViewportCapture({
          browserPid: params.browserPid,
          session,
        });
        cachedPid = params.browserPid;
      } finally {
        setupLock = null;
        resolve();
      }
    }
    return await captureViewportPng({
      capture: cachedCapture,
      timeoutMs: params.timeoutMs ?? 2000,
    });
  } catch {
    if (cachedCapture) {
      await teardownHeadedBrowserViewportCapture(cachedCapture).catch(() => {});
    }
    cachedCapture = null;
    cachedPid = null;
    return null;
  }
}
