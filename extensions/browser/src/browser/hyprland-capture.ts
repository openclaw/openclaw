import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolveSystemBin } from "openclaw/plugin-sdk/infra-runtime";

const execFileAsync = promisify(execFile);

type CaptureState = {
  outputName: string;
  browserPid: number;
  hyprctl: string;
};

let _state: CaptureState | null = null;
let _setupInFlight: Promise<CaptureState> | null = null;

// Points at the most-recently-created virtual output so the exit handler can
// always clean up even after a PID-change re-setup.
let _cleanupOutputName: string | null = null;
let _cleanupHyprctl: string | null = null;
let _cleanupRegistered = false;
let _exitListener: (() => void) | null = null;
let _sigintListener: (() => void) | null = null;
let _sigtermListener: (() => void) | null = null;

export function isHyprlandAvailable(): boolean {
  return Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE?.trim());
}

async function listMonitorNames(hyprctl: string): Promise<Set<string>> {
  const { stdout } = await execFileAsync(hyprctl, ["monitors", "-j"]);
  const monitors = JSON.parse(stdout) as Array<{ name: string }>;
  return new Set(monitors.map((m) => m.name));
}

async function createHeadlessOutput(hyprctl: string): Promise<string> {
  const before = await listMonitorNames(hyprctl);
  await execFileAsync(hyprctl, ["create-output"]);
  const after = await listMonitorNames(hyprctl);
  for (const name of after) {
    if (!before.has(name)) {
      return name;
    }
  }
  throw new Error("hyprctl create-output completed but no new monitor appeared");
}

async function getActiveWorkspaceId(hyprctl: string, monitorName: string): Promise<number> {
  const { stdout } = await execFileAsync(hyprctl, ["monitors", "-j"]);
  const monitors = JSON.parse(stdout) as Array<{
    name: string;
    activeWorkspace: { id: number };
  }>;
  const monitor = monitors.find((m) => m.name === monitorName);
  if (!monitor) {
    throw new Error(`Monitor "${monitorName}" not found after creation`);
  }
  return monitor.activeWorkspace.id;
}

function registerExitCleanup(hyprctl: string, outputName: string): void {
  // Always update the target so the handler removes the current output.
  _cleanupOutputName = outputName;
  _cleanupHyprctl = hyprctl;

  if (_cleanupRegistered) {
    return;
  }
  _cleanupRegistered = true;

  const cleanup = () => {
    const h = _cleanupHyprctl;
    const o = _cleanupOutputName;
    if (!h || !o) {
      return;
    }
    try {
      execFileSync(h, ["output", "remove", o], { timeout: 2000 });
    } catch {
      // Best-effort; process is exiting.
    }
  };

  _exitListener = cleanup;
  _sigintListener = () => {
    cleanup();
  };
  _sigtermListener = () => {
    cleanup();
  };

  process.once("exit", _exitListener);
  process.once("SIGINT", _sigintListener);
  process.once("SIGTERM", _sigtermListener);
}

async function setupCapture(browserPid: number): Promise<CaptureState> {
  const hyprctl = resolveSystemBin("hyprctl", { trust: "standard" });
  if (!hyprctl) {
    throw new Error("hyprctl not found in trusted system directories");
  }
  const grim = resolveSystemBin("grim", { trust: "standard" });
  if (!grim) {
    throw new Error("grim not found in trusted system directories");
  }

  const outputName = await createHeadlessOutput(hyprctl);
  const workspaceId = await getActiveWorkspaceId(hyprctl, outputName);
  await execFileAsync(hyprctl, [
    "dispatch",
    "movetoworkspacesilent",
    `${workspaceId},pid:${browserPid}`,
  ]);

  registerExitCleanup(hyprctl, outputName);
  return { outputName, browserPid, hyprctl };
}

export async function teardownHyprlandCapture(): Promise<void> {
  const state = _state;
  _state = null;
  _setupInFlight = null;
  if (!state) {
    return;
  }
  try {
    await execFileAsync(state.hyprctl, ["output", "remove", state.outputName]);
    _cleanupOutputName = null;
  } catch {
    // Best-effort.
  }
}

async function runGrimCapture(outputName: string, timeoutMs: number): Promise<Buffer> {
  const grimBin = resolveSystemBin("grim", { trust: "standard" });
  if (!grimBin) {
    throw new Error("grim not found in trusted system directories");
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const child = spawn(grimBin, ["-o", outputName, "-t", "png", "-"], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new Error(`grim timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }
      settled = true;
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`grim exited with code ${code ?? "null"}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    });
  });
}

/**
 * Capture the browser viewport via grim on Hyprland.
 *
 * Throws on any failure (binary missing, hyprctl error, grim crash).
 * On failure the cached state is reset so the next call retries setup.
 * Callers should wrap with `.catch(() => null)` to fall back silently.
 */
export async function captureWithHyprland(params: {
  browserPid: number;
  timeoutMs?: number;
}): Promise<Buffer> {
  const { browserPid, timeoutMs = 5000 } = params;

  // PID changed → tear down old virtual output and re-setup.
  if (_state && _state.browserPid !== browserPid) {
    await teardownHyprlandCapture();
  }

  if (!_state) {
    // Deduplicate concurrent callers: all share the same in-flight promise.
    const inFlight = (_setupInFlight ??= setupCapture(browserPid)
      .then((state) => {
        _state = state;
        _setupInFlight = null;
        return state;
      })
      .catch((err: unknown) => {
        _state = null;
        _setupInFlight = null;
        throw err;
      }));

    // May throw if setup fails; caller handles via .catch.
    _state = await inFlight;
  }

  const { outputName } = _state;
  try {
    return await runGrimCapture(outputName, timeoutMs);
  } catch (err) {
    // Capture error → remove the orphaned virtual output and reset cache so the next call retries setup.
    await teardownHyprlandCapture().catch(() => {});
    throw err;
  }
}

/** Reset all module-level state. For tests only. */
export function _resetHyprlandCaptureForTests(): void {
  if (_exitListener) {
    process.removeListener("exit", _exitListener);
    _exitListener = null;
  }
  if (_sigintListener) {
    process.removeListener("SIGINT", _sigintListener);
    _sigintListener = null;
  }
  if (_sigtermListener) {
    process.removeListener("SIGTERM", _sigtermListener);
    _sigtermListener = null;
  }
  _state = null;
  _setupInFlight = null;
  _cleanupOutputName = null;
  _cleanupHyprctl = null;
  _cleanupRegistered = false;
}
