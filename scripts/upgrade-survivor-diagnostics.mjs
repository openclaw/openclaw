// Host-only entrypoint: this file and app source are never mounted into the
// package-under-test container. Keep the capture module dependency-light.
import { writeSync } from "node:fs";
import { publishDiagnostics } from "./e2e/lib/upgrade-survivor/diagnostics.mjs";

try {
  const [mode, artifactRoot, destination, outcome = "failed"] = process.argv.slice(2);
  if (mode !== "publish") {
    throw new Error();
  }
  // The wrapper registers this harness's scripts/tsx.mjs before loading source.
  const { redactSensitiveText } = await import("../src/logging/redact.ts");
  const failure = publishDiagnostics(artifactRoot, destination, redactSensitiveText, outcome);
  // Use the host scheduler pipe, which is not forwarded into the container.
  // Wrapper cleanup and bounded log tails cannot clip this published receipt.
  if (failure && process.env.OPENCLAW_DOCKER_FAILURE_METADATA_FD === "3") {
    try {
      writeSync(3, `${JSON.stringify(failure)}\n`);
    } catch {
      process.stderr.write("Upgrade survivor failure metadata unavailable.\n");
    }
  } else if (process.env.GITHUB_ACTIONS === "true" && failure) {
    const phase = failure.phase
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");
    process.stderr.write(
      `::error title=Upgrade survivor failure::phase=${phase}; exitStatus=${failure.exitStatus}; signal=${failure.signal ?? "none"}\n`,
    );
  }
} catch {
  process.stderr.write("Upgrade survivor diagnostics missing: safe host publication failed.\n");
  process.exitCode = 1;
}
