// Host-only entrypoint: this file and app source are never mounted into the
// package-under-test container. Keep the capture module dependency-light.
import { publishDiagnostics } from "./e2e/lib/upgrade-survivor/diagnostics.mjs";

try {
  const [mode, artifactRoot, destination, outcome = "failed"] = process.argv.slice(2);
  if (mode !== "publish") {
    throw new Error();
  }
  // The wrapper registers this harness's scripts/tsx.mjs before loading source.
  const { redactSensitiveText } = await import("../src/logging/redact.ts");
  const failure = publishDiagnostics(artifactRoot, destination, redactSensitiveText, outcome);
  // The scheduler prints this final log tail. Direct publisher callers (including
  // tests) must not emit CI errors merely because they project a failure fixture.
  if (process.env.GITHUB_ACTIONS === "true" && failure) {
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
