import fs from "node:fs/promises";
import path from "node:path";
import type { ManagedGatewayBinding } from "../../src/daemon/managed-gateway-bindings.ts";
import type { GatewayServiceEnv, GatewayServiceState } from "../../src/daemon/service-types.ts";
import { isPidAlive } from "../../src/shared/pid-alive.ts";

type LiveGatewayDistFenceResult = { refuse: true; message: string } | { refuse: false };

/** True when the managed service still holds a live process on this checkout's dist. */
function isLiveManagedGatewayHoldingDist(state: GatewayServiceState): boolean {
  if (state.running) {
    return true;
  }
  if ((state.runtime?.systemd?.tasksCurrent ?? 0) > 0) {
    return true;
  }
  const pid = state.runtime?.pid;
  if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1 && isPidAlive(pid)) {
    return true;
  }
  const serviceState = state.runtime?.state?.toLowerCase() ?? "";
  const subState = state.runtime?.subState?.toLowerCase() ?? "";
  // systemd stop/restart drains keep MainPID alive under deactivating states.
  return (
    serviceState === "deactivating" ||
    subState === "stop-sigterm" ||
    subState === "stop-sigkill" ||
    subState === "final-sigterm"
  );
}

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
    params.startupEntries.length > 0
      ? `From an external terminal, stop every listed Gateway (${stopHints}), run \`pnpm build\` in this checkout, then after a successful build start the same Startup entries and any listed services.`
      : `From an external terminal, stop every listed Gateway (${stopHints} or the matching service stops), ` +
        `run \`pnpm build\` in this checkout, then after a successful build start those services (${startHints} or the matching service starts). ` +
        `\`openclaw update\` can apply an available update; an already-current result does not rebuild stale dist.`;
  return (
    `[openclaw] Refusing to rebuild dist while a managed Gateway${profileText}${unit} is still running from this checkout's dist${entry}. ` +
    recovery
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

  const checkoutDist = await tryRealpath(path.join(checkoutRoot, "dist"));
  const checkoutDistStat = await fs.stat(checkoutDist).catch(() => null);
  if (!checkoutDistStat?.isDirectory()) {
    return false;
  }
  const servingDist = await tryRealpath(path.join(servingRoot, "dist"));
  const servingEntryReal = await tryRealpath(servingEntry);

  if (runtime.isPathInside(checkoutDist, servingEntryReal)) {
    return true;
  }
  // The packaged launcher imports dist/entry; a shared package root alone is insufficient.
  if (
    !runtime.isPathInside(servingDist, servingEntryReal) &&
    servingEntryReal !== path.join(servingRoot, "openclaw.mjs")
  ) {
    return false;
  }
  if (await samePathIdentity(checkoutDist, servingDist)) {
    return true;
  }
  return (
    runtime.isPathInside(checkoutDist, servingDist) ||
    runtime.isPathInside(servingDist, checkoutDist)
  );
}

async function resolveFenceBindings(
  env: NodeJS.ProcessEnv,
): Promise<readonly ManagedGatewayBinding[] | null> {
  try {
    const current = bindingFromProcessEnv(env);
    const inspect = await import("../../src/daemon/managed-gateway-bindings.ts");
    const discovered = await inspect.discoverManagedGatewayBindings(env);
    return dedupeBindings([current, ...discovered]);
  } catch {
    return null;
  }
}

/**
 * Returns a refuse decision when a managed Gateway ExecStart resolves into
 * `checkoutRoot` and the service still holds a live process.
 */
export async function resolveLiveManagedGatewayDistFence(
  checkoutRoot: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<LiveGatewayDistFenceResult> {
  const env = options.env ?? process.env;
  const bindings = await resolveFenceBindings(env);
  if (!bindings) {
    return { refuse: false };
  }

  const root = path.resolve(checkoutRoot);
  const holds: Array<{
    profile: string;
    state: GatewayServiceState;
    windowsStartupEntry?: string;
  }> = [];
  for (const binding of bindings) {
    try {
      const runtime = await loadFenceRuntime();
      if (!runtime) {
        continue;
      }
      // A discovered sibling keeps its own selectors, rather than ambient profile overrides.
      const state = await runtime.readGatewayServiceState(runtime.resolveGatewayService(), {
        env: binding.env,
        requireEffective: true,
        requireLoadedCommand: true,
        ...(binding.systemdReadTarget ? { systemdReadTarget: binding.systemdReadTarget } : {}),
        ...(binding.windowsStartupEntry !== undefined
          ? { windowsStartupEntry: binding.windowsStartupEntry }
          : {}),
      });
      const matches = await gatewayServiceCommandOverlapsPhysicalCheckout(root, state.command);
      if (matches !== true) {
        continue;
      }
      if (!isLiveManagedGatewayHoldingDist(state)) {
        continue;
      }
      holds.push({
        profile: normalizeFenceProfile(binding.profile),
        state,
        ...(binding.windowsStartupEntry !== undefined
          ? { windowsStartupEntry: binding.windowsStartupEntry }
          : {}),
      });
    } catch {
      // Fail open per binding.
    }
  }
  if (holds.length === 0) {
    return { refuse: false };
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
        .filter((hold) => hold.windowsStartupEntry === undefined)
        .map((hold) => hold.profile),
      startupEntries: holds.flatMap((hold) =>
        hold.windowsStartupEntry === undefined ? [] : [hold.windowsStartupEntry],
      ),
      ...(entrypoint ? { entrypoint } : {}),
      ...(unit ? { unit } : {}),
    }),
  };
}
