import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";

const log = createSubsystemLogger("crabbox/provisioning");

/** Fixed phase names and scalar outcomes only; never profile, command, credential or output data. */
export async function measureCrabboxProvisionPhase<T>(
  phase:
    | "project.preparation"
    | "snapshot.verification"
    | "node.enrollment.command"
    | "node.readiness",
  run: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let outcome: "success" | "failed" = "failed";
  try {
    const result = await run();
    outcome = "success";
    return result;
  } finally {
    try {
      const fields = { phase, durationMs: performance.now() - started, outcome };
      log.info("Crabbox provisioning phase", {
        ...fields,
        consoleMessage: `Crabbox provisioning phase ${JSON.stringify(fields)}`,
      });
    } catch {
      /* Timing cannot change the operation's outcome. */
    }
  }
}
