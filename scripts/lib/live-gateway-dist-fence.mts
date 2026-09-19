// Refuse dist mutation while a managed Gateway still runs from this checkout's dist.
import fs from "node:fs/promises";
import path from "node:path";
import type { GatewayServiceEnv, GatewayServiceState } from "../../src/daemon/service-types.ts";

export type LiveGatewayDistFenceDeps = {
  env?: NodeJS.ProcessEnv;
  readState?: () => Promise<GatewayServiceState>;
  matchesRoot?: (root: string, command: GatewayServiceState["command"]) => Promise<boolean | null>;
  isPidAlive?: (pid: number) => boolean;
};

export type LiveGatewayDistFenceResult = { refuse: true; message: string } | { refuse: false };

const ALLOW_ENV = "OPENCLAW_ALLOW_LIVE_DIST_BUILD";

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True when the managed service still holds a live process on this checkout's dist. */
export function isLiveManagedGatewayHoldingDist(
  state: GatewayServiceState,
  options: { isPidAlive?: (pid: number) => boolean } = {},
): boolean {
  if (state.running) {
    return true;
  }
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const pid = state.runtime?.pid;
  if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1 && isPidAlive(pid)) {
    return true;
  }
  const status = state.runtime?.status?.toLowerCase() ?? "";
  const subState = state.runtime?.subState?.toLowerCase() ?? "";
  // systemd stop/restart drains keep MainPID alive under deactivating states.
  return (
    status === "deactivating" ||
    subState === "stop-sigterm" ||
    subState === "stop-sigkill" ||
    subState === "final-sigterm"
  );
}

function formatRefuseMessage(params: { entrypoint?: string; unit?: string }): string {
  const entry = params.entrypoint ? ` (${params.entrypoint})` : "";
  const unit = params.unit ? ` unit ${params.unit}` : "";
  return (
    `[openclaw] Refusing to rebuild dist while a managed Gateway${unit} is still running from this checkout's dist${entry}. ` +
    "Stop the Gateway first (`openclaw gateway stop` or the matching service stop), rebuild, then start. " +
    `Set ${ALLOW_ENV}=1 only for intentional live mutations.`
  );
}

async function tryRealpath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

async function loadFenceRuntime() {
  try {
    const [layout, service, pathGuards] = await Promise.all([
      import("../../src/daemon/service-layout.ts"),
      import("../../src/daemon/service.ts"),
      import("../../src/infra/path-guards.ts"),
    ]);
    return {
      summarizeGatewayServiceLayout: layout.summarizeGatewayServiceLayout,
      resolveServiceEntrypoint: layout.resolveServiceEntrypoint,
      readGatewayServiceState: service.readGatewayServiceState,
      resolveGatewayService: service.resolveGatewayService,
      isPathInside: pathGuards.isPathInside,
    };
  } catch {
    return null;
  }
}

async function samePathIdentity(left: string, right: string): Promise<boolean> {
  if (left === right) {
    return true;
  }
  const [leftStat, rightStat] = await Promise.all([
    fs.stat(left).catch(() => null),
    fs.stat(right).catch(() => null),
  ]);
  return Boolean(
    leftStat && rightStat && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino,
  );
}

/**
 * True when this checkout's dist physically overlaps the serving Gateway
 * artifacts. Logical current/releases ownership is not enough.
 */
export async function gatewayServiceCommandOverlapsPhysicalCheckout(
  checkoutRoot: string,
  command: GatewayServiceState["command"],
): Promise<boolean | null> {
  const runtime = await loadFenceRuntime();
  if (!runtime) {
    return null;
  }
  const layout = await runtime.summarizeGatewayServiceLayout(command);
  const servingRoot = layout?.packageRootReal ?? layout?.packageRoot;
  const servingEntry = layout?.entrypointReal ?? layout?.entrypoint;
  if (
    !servingRoot ||
    !servingEntry ||
    (!path.isAbsolute(servingEntry) && !path.win32.isAbsolute(servingEntry))
  ) {
    return null;
  }

  const checkoutReal = await tryRealpath(checkoutRoot);
  const checkoutDist = await tryRealpath(path.join(checkoutRoot, "dist"));
  const servingDist = await tryRealpath(path.join(servingRoot, "dist"));
  const servingEntryReal = await tryRealpath(servingEntry);

  if (await samePathIdentity(checkoutReal, servingRoot)) {
    return true;
  }
  if (await samePathIdentity(checkoutDist, servingDist)) {
    return true;
  }
  return (
    runtime.isPathInside(checkoutDist, servingEntryReal) ||
    runtime.isPathInside(checkoutDist, servingDist) ||
    runtime.isPathInside(servingDist, checkoutDist)
  );
}

/**
 * Returns a refuse decision when a managed Gateway ExecStart resolves into
 * `checkoutRoot` and the service still holds a live process.
 */
export async function resolveLiveManagedGatewayDistFence(
  checkoutRoot: string,
  deps: LiveGatewayDistFenceDeps = {},
): Promise<LiveGatewayDistFenceResult> {
  const env = deps.env ?? process.env;
  if (env[ALLOW_ENV] === "1") {
    return { refuse: false };
  }

  const readState =
    deps.readState ??
    (async () => {
      const runtime = await loadFenceRuntime();
      if (!runtime) {
        throw new Error("gateway service inspection unavailable");
      }
      return await runtime.readGatewayServiceState(runtime.resolveGatewayService(), {
        env: env as GatewayServiceEnv,
      });
    });
  const matchesRoot =
    deps.matchesRoot ??
    ((root, command) => gatewayServiceCommandOverlapsPhysicalCheckout(root, command));

  let state: GatewayServiceState;
  try {
    state = await readState();
  } catch {
    // Hosts without a managed service, or inspection failures, must not block
    // ordinary builds. Only a positive live match refuses.
    return { refuse: false };
  }

  const root = path.resolve(checkoutRoot);
  let matches: boolean | null;
  try {
    matches = await matchesRoot(root, state.command);
  } catch {
    return { refuse: false };
  }
  if (matches !== true) {
    return { refuse: false };
  }
  if (!isLiveManagedGatewayHoldingDist(state, { isPidAlive: deps.isPidAlive })) {
    return { refuse: false };
  }

  const runtime = await loadFenceRuntime();
  return {
    refuse: true,
    message: formatRefuseMessage({
      ...(state.command && runtime
        ? { entrypoint: runtime.resolveServiceEntrypoint(state.command) }
        : {}),
      ...(state.runtime?.systemd?.unit ? { unit: state.runtime.systemd.unit } : {}),
    }),
  };
}
