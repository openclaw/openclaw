import fs from "node:fs/promises";
import path from "node:path";
import type { LoadedLaunchAgentState } from "../../src/daemon/launchd-runtime.ts";
import type { ManagedGatewayBinding } from "../../src/daemon/managed-gateway-bindings.ts";
import type { GatewayServiceState } from "../../src/daemon/service-types.ts";
import { hasErrnoCode } from "../../src/infra/errno.ts";
import { hasCommandProcessCleanupError } from "../../src/process/exec-result.ts";

type LiveGatewayDistFenceResult = { refuse: true; message: string } | { refuse: false };
function formatRefuseMessage(params: {
  owners: readonly string[];
  showUpdateHint: boolean;
  entrypoint?: string;
  unit?: string;
}): string {
  const owners = [...new Set(params.owners)].join(", ");
  const entry = params.entrypoint ? ` (${params.entrypoint})` : "";
  const unit = params.unit ? ` unit ${params.unit}` : "";
  return (
    `[openclaw] Refusing to rebuild artifacts while a managed Gateway (${owners}) is still using overlapping build outputs${unit}${entry}. ` +
    "From an external terminal, stop every listed Gateway through its original native service or Startup owner, " +
    "run `pnpm build` in this checkout, then after a successful build start those same services." +
    (params.showUpdateHint
      ? " `openclaw update` can apply an available update; an already-current result does not rebuild stale dist."
      : "")
  );
}

async function tryRealpath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  try {
    return await fs.realpath(resolved);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    // Missing output keeps its physical parent; dangling links never prove separation.
    const entry = await fs.lstat(resolved).catch((failure: unknown) => {
      if (!hasErrnoCode(failure, "ENOENT")) {
        throw failure;
      }
      return null;
    });
    const parent = path.dirname(resolved);
    if (entry || parent === resolved) {
      throw error;
    }
    return path.join(await tryRealpath(parent), path.basename(resolved));
  }
}

async function loadFenceRuntime() {
  try {
    const [layout, bindings, pathGuards, serviceRuntime, inspection] = await Promise.all([
      import("../../src/daemon/service-layout.ts"),
      import("../../src/daemon/managed-gateway-bindings.ts"),
      import("../../src/infra/path-guards.ts"),
      import("../../src/daemon/service-runtime.ts"),
      import("../../src/daemon/service-inspection-error.ts"),
    ]);
    return {
      summarizeGatewayServiceLayout: layout.summarizeGatewayServiceLayout,
      resolveServiceEntrypoint: layout.resolveServiceEntrypoint,
      readManagedGatewayBindingState: bindings.readManagedGatewayBindingState,
      describeManagedGatewayBinding: bindings.describeManagedGatewayBinding,
      isPathInside: pathGuards.isPathInside,
      isGatewayServiceStateLive: serviceRuntime.isGatewayServiceStateLive,
      isServiceManagerAbsent: (error: unknown) =>
        error instanceof inspection.ServiceInspectionError &&
        error.reason === "service-manager-unavailable",
    };
  } catch {
    return null;
  }
}

async function samePathIdentity(
  left: string,
  right: string,
  statCache: Map<string, Promise<Awaited<ReturnType<typeof fs.stat>> | null>>,
): Promise<boolean> {
  if (left === right) {
    return true;
  }
  const stat = (file: string) => {
    let pending = statCache.get(file);
    if (!pending) {
      pending = fs.stat(file).catch((error: unknown) => {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
        return null;
      });
      statCache.set(file, pending);
    }
    return pending;
  };
  const [leftStat, rightStat] = await Promise.all([left, right].map(stat));
  return Boolean(
    leftStat && rightStat && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino,
  );
}

/**
 * True when a written output root physically overlaps the serving Gateway
 * artifacts. Logical current/releases ownership is not enough.
 */
export async function gatewayServiceCommandOverlapsPhysicalCheckout(
  checkoutRoot: string,
  command: GatewayServiceState["command"],
  options: { requireVerified?: boolean; outputPaths?: readonly string[] } = {},
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

  const servingEntryReal = await tryRealpath(servingEntry);
  const outputPaths = options.outputPaths ?? ["dist"];
  const servingOutputs = await Promise.all(
    outputPaths.map((output) => tryRealpath(path.join(servingRoot, output))),
  );
  const statCache = new Map<string, Promise<Awaited<ReturnType<typeof fs.stat>> | null>>();
  // A source entry outside generated outputs does not hold their imports open.
  // The packaged launcher imports generated outputs from its package root.
  if (
    !servingOutputs.some((output) => runtime.isPathInside(output, servingEntryReal)) &&
    servingEntryReal !== path.join(servingRoot, "openclaw.mjs")
  ) {
    return false;
  }
  for (const output of outputPaths) {
    const checkoutOutput = await tryRealpath(path.join(checkoutRoot, output));
    if (!options.requireVerified) {
      const existing = await fs.stat(checkoutOutput).catch(() => null);
      if (!existing?.isDirectory()) {
        continue;
      }
    }
    if (runtime.isPathInside(checkoutOutput, servingEntryReal)) {
      return true;
    }
    for (const servingOutput of servingOutputs) {
      if (
        runtime.isPathInside(checkoutOutput, servingOutput) ||
        runtime.isPathInside(servingOutput, checkoutOutput) ||
        (await samePathIdentity(checkoutOutput, servingOutput, statCache))
      ) {
        return true;
      }
    }
  }
  return false;
}

async function resolveFenceBindings(
  env: NodeJS.ProcessEnv,
  requireComplete?: boolean,
): Promise<readonly ManagedGatewayBinding[] | null> {
  try {
    const inspect = await import("../../src/daemon/managed-gateway-bindings.ts");
    return await inspect.discoverManagedGatewayBindings(env, {
      requireComplete,
      includeInvoking: true,
    });
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    return null;
  }
}

/**
 * Returns a refuse decision when a managed Gateway ExecStart resolves into
 * `checkoutRoot` and the service still holds a live process.
 */
export async function resolveLiveManagedGatewayDistFence(
  checkoutRoot: string,
  options: {
    env?: NodeJS.ProcessEnv;
    requireVerified?: boolean;
    outputPaths?: readonly string[];
  } = {},
): Promise<LiveGatewayDistFenceResult> {
  const env = options.env ?? process.env;
  const unknown = {
    refuse: true,
    message:
      "[openclaw] Cannot verify that test preparation is separate from managed Gateway artifacts. Use the existing isolated test runner; no checkout artifacts were rebuilt.",
  } as const;
  // Name each owner whose separation stayed unproven, so the refusal points at it.
  const unverifiedOwners: string[] = [];
  const bindings = await resolveFenceBindings(env, options.requireVerified);
  if (!bindings) {
    return options.requireVerified ? unknown : { refuse: false };
  }

  const root = path.resolve(checkoutRoot);
  const holds: Array<{
    owner: string;
    binding: ManagedGatewayBinding;
    state: LoadedLaunchAgentState;
  }> = [];
  let unverified = false;
  for (const binding of bindings) {
    try {
      const runtime = await loadFenceRuntime();
      if (!runtime) {
        unverified = true;
        continue;
      }
      if (options.requireVerified && process.platform === "linux") {
        // Artifact separation needs the loaded command, not protected service credentials.
        // An unavailable location never grants permission; the full owner may still prove absence.
        const { readSystemdServiceCommandLocation } =
          await import("../../src/daemon/systemd-service-files.ts");
        const location = await readSystemdServiceCommandLocation(
          binding.env,
          binding.systemdReadTarget,
        ).catch((error: unknown) => {
          if (hasCommandProcessCleanupError(error)) {
            throw error;
          }
          return undefined;
        });
        if (
          location?.kind === "not-loaded" ||
          (location?.kind === "command" &&
            (await gatewayServiceCommandOverlapsPhysicalCheckout(
              root,
              location.command,
              options,
            )) === false)
        ) {
          continue;
        }
      }
      // A discovered sibling keeps its own selectors, rather than ambient profile overrides.
      const state = await runtime.readManagedGatewayBindingState(binding);
      const matches = await gatewayServiceCommandOverlapsPhysicalCheckout(
        root,
        state.command,
        options,
      );
      if (matches === false) {
        continue;
      }
      // Scheduler occupancy can hold old argv or a pending launch without proving
      // the current command is running. It fences overlapping outputs, not service control.
      const occupiedWindowsTask =
        process.platform === "win32" &&
        !binding.windowsStartupEntry &&
        (state.runtime?.state === "Running" || state.runtime?.state === "Queued");
      const live = runtime.isGatewayServiceStateLive(state) || occupiedWindowsTask;
      // A stopped owner holds nothing. A live one whose command does not resolve to a
      // path (e.g. a wrapper script) cannot prove separation, so it stays unverified.
      if (!live || matches === null) {
        if (live || state.runtime?.status !== "stopped" || state.loadState.status === "unknown") {
          unverified = true;
          unverifiedOwners.push(runtime.describeManagedGatewayBinding(binding, state));
        }
        continue;
      }
      holds.push({ owner: runtime.describeManagedGatewayBinding(binding, state), binding, state });
    } catch (error) {
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      // A container or CI pod without a service manager cannot host a managed
      // Gateway. Only the invoking selector may rely on that proof: a discovered
      // service definition, or any other inspection failure, stays unverified.
      if (binding.env === env && (await loadFenceRuntime())?.isServiceManagerAbsent(error)) {
        continue;
      }
      unverified = true;
    }
  }
  if (holds.length === 0) {
    if (!options.requireVerified || !unverified) {
      return { refuse: false };
    }
    return unverifiedOwners.length === 0
      ? unknown
      : {
          refuse: true,
          message: `${unknown.message} Unverified: ${[...new Set(unverifiedOwners)].join(", ")}.`,
        };
  }

  const runtime = await loadFenceRuntime();
  let entrypoint: string | undefined;
  let unit: string | undefined;
  for (const hold of holds) {
    if (!entrypoint && hold.state.command && runtime) {
      entrypoint = runtime.resolveServiceEntrypoint(hold.state.command);
    }
    if (!unit && hold.state.runtime?.systemd?.unit) {
      unit = hold.state.runtime.systemd.unit;
    }
  }

  return {
    refuse: true,
    message: formatRefuseMessage({
      owners: holds.map((hold) => hold.owner),
      showUpdateHint: !holds.some(
        (hold) => hold.binding.windowsStartupEntry || hold.state.launchAgent,
      ),
      ...(entrypoint ? { entrypoint } : {}),
      ...(unit ? { unit } : {}),
    }),
  };
}
