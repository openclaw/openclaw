import fs from "node:fs/promises";
import path from "node:path";
import type { ManagedGatewayBinding } from "../../src/daemon/managed-gateway-bindings.ts";
import type { GatewayServiceEnv, GatewayServiceState } from "../../src/daemon/service-types.ts";
import { hasErrnoCode } from "../../src/infra/errno.ts";
import { hasCommandProcessCleanupError } from "../../src/process/exec-result.ts";

type LiveGatewayDistFenceResult = { refuse: true; message: string } | { refuse: false };
type LaunchAgentHint = { target: string; sourcePath: string };

function normalizeFenceProfile(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") {
    return "default";
  }
  return trimmed;
}

function bindingFromProcessEnv(env: NodeJS.ProcessEnv): ManagedGatewayBinding {
  return {
    profile: normalizeFenceProfile(env.OPENCLAW_PROFILE),
    env: env as GatewayServiceEnv,
  };
}

function bindingSelectorKey(binding: ManagedGatewayBinding): string {
  return [
    binding.profile,
    binding.scope ?? binding.systemdReadTarget?.scope ?? "",
    binding.systemdReadTarget?.unitPath ?? "",
    binding.launchAgentPlistPath ?? "",
    binding.windowsStartupEntry
      ? path.win32.normalize(binding.windowsStartupEntry).toLowerCase()
      : "",
    binding.env.OPENCLAW_SYSTEMD_UNIT ?? "",
    binding.env.OPENCLAW_LAUNCHD_LABEL ?? "",
    binding.env.OPENCLAW_WINDOWS_TASK_NAME ?? "",
  ].join("\0");
}

function dedupeBindings(bindings: readonly ManagedGatewayBinding[]): ManagedGatewayBinding[] {
  const seen = new Set<string>();
  const out: ManagedGatewayBinding[] = [];
  for (const binding of bindings) {
    const key = bindingSelectorKey(binding);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(binding);
  }
  return out;
}

function formatServiceHint(profile: string, action: "stop" | "start"): string {
  return profile === "default"
    ? `\`openclaw gateway ${action}\``
    : `\`openclaw gateway ${action} --profile ${profile}\``;
}

function formatRefuseMessage(params: {
  profiles: readonly string[];
  entrypoint?: string;
  unit?: string;
  serviceProfiles: readonly string[];
  startupEntries: readonly string[];
  launchAgents: readonly LaunchAgentHint[];
}): string {
  const profiles = [...new Set(params.profiles)].toSorted((left, right) =>
    (left ?? "").localeCompare(right ?? ""),
  );
  const profileText =
    profiles.length === 1 ? ` (profile ${profiles[0]})` : ` (profiles ${profiles.join(", ")})`;
  const entry = params.entrypoint ? ` (${params.entrypoint})` : "";
  const unit = params.unit ? ` unit ${params.unit}` : "";
  const stopHints = [
    ...new Set(params.serviceProfiles.map((profile) => formatServiceHint(profile, "stop"))),
    ...new Set(
      params.launchAgents.map(
        (agent) =>
          `stop launchd job ${JSON.stringify(agent.target)} loaded from ${JSON.stringify(agent.sourcePath)}`,
      ),
    ),
    ...new Set(
      params.startupEntries.map(
        (startupPath) =>
          `stop the process launched by Startup entry ${JSON.stringify(startupPath)}`,
      ),
    ),
  ].join(", ");
  const startHints = params.serviceProfiles
    .map((profile) => formatServiceHint(profile, "start"))
    .join(", ");
  const recovery =
    params.launchAgents.length > 0
      ? `From an external terminal, stop every listed Gateway (${stopHints}), run \`pnpm build\` in this checkout, then after a successful build start the same listed services and Startup entries through their original owners.`
      : params.startupEntries.length > 0
        ? `From an external terminal, stop every listed Gateway (${stopHints}), run \`pnpm build\` in this checkout, then after a successful build start the same Startup entries and any listed services.`
        : `From an external terminal, stop every listed Gateway (${stopHints} or the matching service stops), ` +
          `run \`pnpm build\` in this checkout, then after a successful build start those services (${startHints} or the matching service starts). ` +
          `\`openclaw update\` can apply an available update; an already-current result does not rebuild stale dist.`;
  return (
    `[openclaw] Refusing to rebuild artifacts while a managed Gateway${profileText}${unit} is still using overlapping build outputs${entry}. ` +
    recovery
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
    const [layout, bindings, pathGuards, serviceRuntime] = await Promise.all([
      import("../../src/daemon/service-layout.ts"),
      import("../../src/daemon/managed-gateway-bindings.ts"),
      import("../../src/infra/path-guards.ts"),
      import("../../src/daemon/service-runtime.ts"),
    ]);
    return {
      summarizeGatewayServiceLayout: layout.summarizeGatewayServiceLayout,
      resolveServiceEntrypoint: layout.resolveServiceEntrypoint,
      readManagedGatewayBindingState: bindings.readManagedGatewayBindingState,
      isPathInside: pathGuards.isPathInside,
      isGatewayServiceStateLive: serviceRuntime.isGatewayServiceStateLive,
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
    const current = bindingFromProcessEnv(env);
    const inspect = await import("../../src/daemon/managed-gateway-bindings.ts");
    const discovered = await inspect.discoverManagedGatewayBindings(env, { requireComplete });
    return dedupeBindings([current, ...discovered]);
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
  const bindings = await resolveFenceBindings(env, options.requireVerified);
  if (!bindings) {
    return options.requireVerified ? unknown : { refuse: false };
  }

  const root = path.resolve(checkoutRoot);
  const holds: Array<{
    profile: string;
    state: GatewayServiceState;
    windowsStartupEntry?: string;
    launchAgent?: LaunchAgentHint;
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
      if (matches === null) {
        unverified ||= Boolean(
          state.command ||
          state.installed ||
          state.loadState.status !== "not-loaded" ||
          state.runtime?.missingUnit !== true,
        );
        continue;
      }
      if (!runtime.isGatewayServiceStateLive(state)) {
        unverified ||= state.runtime?.status !== "stopped" || state.loadState.status === "unknown";
        continue;
      }
      holds.push({
        profile: normalizeFenceProfile(binding.profile),
        state,
        ...(state.launchAgent
          ? {
              launchAgent: {
                target: state.launchAgent.target,
                sourcePath: state.launchAgent.sourcePath,
              },
            }
          : {}),
        ...(binding.windowsStartupEntry !== undefined
          ? { windowsStartupEntry: binding.windowsStartupEntry }
          : {}),
      });
    } catch (error) {
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      unverified = true;
    }
  }
  if (holds.length === 0) {
    return options.requireVerified && unverified ? unknown : { refuse: false };
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
      profiles: holds.map((hold) => hold.profile),
      serviceProfiles: holds
        .filter((hold) => hold.windowsStartupEntry === undefined && !hold.launchAgent)
        .map((hold) => hold.profile),
      launchAgents: holds.flatMap((hold) => (hold.launchAgent ? [hold.launchAgent] : [])),
      startupEntries: holds.flatMap((hold) =>
        hold.windowsStartupEntry === undefined ? [] : [hold.windowsStartupEntry],
      ),
      ...(entrypoint ? { entrypoint } : {}),
      ...(unit ? { unit } : {}),
    }),
  };
}
