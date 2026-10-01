import { matchesGlob } from "node:path";

const PUBLISHED_DRIVER_UPDATE_INPUTS = [
  "src/infra/update-*",
  "src/cli/update-cli/**",
  "src/state/openclaw-state-lease*",
  "src/state/openclaw-state-db-open.ts",
  "src/infra/sqlite-*identity*",
  "src/plugins/plugin-native-*",
  "src/cli/startup-trace.ts",
  "src/gateway/server-startup-trace.ts",
  "scripts/**/{update,upgrade,published-driver}-*",
  "scripts/**/{update,upgrade,published-driver}-*/**",
  "scripts/e2e/*{update,upgrade}*",
  "scripts/e2e/lib/*{update,upgrade}*/**",
  "scripts/e2e/parallels/*update*",
  "scripts/{test-update-*,resolve-upgrade-*,doctor-config-upgrade-*}",
  "scripts/lib/source-update-*",
  "scripts/lib/{release-upgrade-*,cross-os-release-checks/packaged-self-update.ts}",
  "scripts/{generate-update-network-budget,linux-updater-manifest}.*",
  "scripts/{package,resolve}-openclaw-*",
  "scripts/ci-build-manifest.mjs",
  "scripts/lib/docker-e2e-scenarios.mts",
  "scripts/lib/ci-published-driver-update-plan.mts",
  "test/scripts/ci-published-driver-update*.test.ts",
  ".github/workflows/{ci,ci-published-driver-update}.yml",
] as const;

export function shouldRunPublishedDriverUpdate(changedPaths: readonly string[] | null): boolean {
  // An unavailable diff must retain the cross-version boundary proof.
  if (!changedPaths?.length) {
    return true;
  }
  return changedPaths.some((changedPath) => {
    const normalizedPath = changedPath.replaceAll("\\", "/");
    return (
      !normalizedPath.trim() ||
      PUBLISHED_DRIVER_UPDATE_INPUTS.some((pattern) => matchesGlob(normalizedPath, pattern))
    );
  });
}
