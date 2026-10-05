import { matchesGlob } from "node:path";

const PUBLISHED_DRIVER_UPDATE_INPUTS = [
  "src/infra/update-*",
  "src/cli/update-cli/**",
  "src/cli/startup-trace.ts",
  "src/gateway/server-startup-trace.ts",
] as const;

export function shouldRunPublishedDriverUpdate(
  changedPaths: readonly string[] | null,
  workflowEventName = "",
): boolean {
  if (workflowEventName === "pull_request") {
    return false;
  }
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
