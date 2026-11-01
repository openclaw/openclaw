// Defines the plugin prerelease validation surface and matching test lanes.
import { BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS } from "./docker-e2e-scenarios.mts";

/** Required behavioral surfaces that plugin prerelease validation must cover. */
const PLUGIN_PRERELEASE_REQUIRED_SURFACES = Object.freeze([
  "package-artifact",
  "bundled-lifecycle",
  "external-plugins",
  "update-no-op",
  "installed-plugin-deps",
  "doctor-fix",
  "config-round-trip",
  "gateway-bootstrap",
  "sdk-compatibility",
  "external-install-boundary",
  "status-diagnostics",
  "npm-registry-plugin",
  "clawhub-registry-plugin",
  "resource-guardrails",
  "plugin-gateway-rpc",
  "live-ish-availability",
]);

const pluginPrereleaseDockerLanes = Object.freeze([
  {
    lane: "npm-onboard-channel-agent",
    surfaces: ["package-artifact", "gateway-bootstrap", "status-diagnostics"],
  },
  {
    lane: "npm-onboard-discord-candidate-channel-agent",
    surfaces: [
      "package-artifact",
      "external-plugins",
      "installed-plugin-deps",
      "gateway-bootstrap",
      "status-diagnostics",
    ],
  },
  {
    lane: "npm-onboard-slack-candidate-channel-agent",
    surfaces: ["package-artifact", "gateway-bootstrap", "status-diagnostics"],
  },
  {
    lane: "doctor-switch",
    surfaces: ["package-artifact", "doctor-fix"],
  },
  {
    lane: "update-channel-switch",
    surfaces: ["package-artifact", "installed-plugin-deps", "update-no-op"],
  },
  {
    lane: "plugins-offline",
    surfaces: ["external-plugins", "sdk-compatibility", "status-diagnostics"],
  },
  {
    lane: "plugins",
    surfaces: [
      "external-plugins",
      "sdk-compatibility",
      "external-install-boundary",
      "status-diagnostics",
    ],
  },
  {
    lane: "kitchen-sink-plugin",
    surfaces: [
      "external-plugins",
      "sdk-compatibility",
      "external-install-boundary",
      "status-diagnostics",
      "npm-registry-plugin",
      "clawhub-registry-plugin",
      "resource-guardrails",
    ],
  },
  {
    lane: "kitchen-sink-rpc",
    surfaces: [
      "external-plugins",
      "sdk-compatibility",
      "gateway-bootstrap",
      "status-diagnostics",
      "npm-registry-plugin",
      "resource-guardrails",
      "plugin-gateway-rpc",
    ],
  },
  {
    lane: "plugin-update",
    surfaces: ["package-artifact", "update-no-op"],
  },
  {
    lane: "config-reload",
    surfaces: ["config-round-trip", "gateway-bootstrap"],
  },
  {
    lane: "gateway-network",
    surfaces: ["gateway-bootstrap", "status-diagnostics"],
  },
  {
    lane: "mcp-channels",
    surfaces: ["gateway-bootstrap", "status-diagnostics"],
  },
  {
    lane: "cron-mcp-cleanup",
    surfaces: ["gateway-bootstrap", "status-diagnostics"],
  },
  ...Array.from({ length: BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS }, (_, index) => ({
    lane: `bundled-plugin-install-uninstall-${index}`,
    surfaces: ["bundled-lifecycle", "package-artifact", "status-diagnostics"],
  })),
]);

const staticChecks = Object.freeze([
  {
    check: "test:extensions:package-boundary:compile",
    checkName: "checks-plugin-prerelease-package-boundary-compile",
    command: "pnpm run test:extensions:package-boundary:compile",
    surfaces: ["package-artifact", "sdk-compatibility"],
  },
  {
    check: "test:extensions:package-boundary:canary",
    checkName: "checks-plugin-prerelease-package-boundary-canary",
    command: "pnpm run test:extensions:package-boundary:canary",
    surfaces: ["package-artifact", "sdk-compatibility"],
  },
  {
    check: "live-ish-availability",
    checkName: "checks-plugin-prerelease-live-ish-availability",
    command: "node --import tsx scripts/plugin-prerelease-liveish-matrix.mts",
    surfaces: ["live-ish-availability"],
  },
]);

/** Run daily extension batches on Bun and retain both runtimes for release proof. */
export async function resolvePluginPrereleaseExtensionRuntime({
  fullReleaseValidation,
  env = process.env,
}: {
  fullReleaseValidation: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  test_runtime_policy: "node" | "bun-all" | "dual-all";
  requires_bun: boolean;
}> {
  const explicitPolicy = env.OPENCLAW_CI_TEST_RUNTIME_POLICY?.trim();
  // Bounded static-planner copies need no test inventory for the event defaults.
  const policy = explicitPolicy
    ? (await import("./ci-test-runtime.mts")).resolveCiTestRuntimePolicy(env)
    : fullReleaseValidation
      ? "dual-all"
      : "bun-all";
  return { test_runtime_policy: policy, requires_bun: policy !== "node" };
}

/** Build the plugin prerelease plan from Docker lanes and static checks. */
export function createPluginPrereleaseTestPlan() {
  const dockerLanes = pluginPrereleaseDockerLanes.map((entry) => entry.lane);
  const allEntries = [...pluginPrereleaseDockerLanes, ...staticChecks];
  return {
    dockerLanes,
    staticChecks: staticChecks.map((entry) => ({
      check: entry.check,
      checkName: entry.checkName,
      command: entry.command,
      surfaces: entry.surfaces.slice(),
    })),
    surfaces: [...new Set(allEntries.flatMap((entry) => entry.surfaces))].toSorted((a, b) =>
      a.localeCompare(b),
    ),
  };
}

/** Assert that a plugin prerelease plan covers every required surface. */
export function assertPluginPrereleaseTestPlanComplete(
  plan: ReturnType<typeof createPluginPrereleaseTestPlan> = createPluginPrereleaseTestPlan(),
) {
  const missing = PLUGIN_PRERELEASE_REQUIRED_SURFACES.filter(
    (surface) => !plan.surfaces.includes(surface),
  );
  if (missing.length > 0) {
    throw new Error(`Plugin prerelease test plan is missing surfaces: ${missing.join(", ")}`);
  }
  return plan;
}
