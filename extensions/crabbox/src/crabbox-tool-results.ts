import type { WorkerMachineOption } from "openclaw/plugin-sdk/plugin-entry";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { textResult } from "openclaw/plugin-sdk/tool-results";

// These are the fields used for presentation, not replacements for Gateway receipts.
export type CrabboxEnvironment = {
  id: string;
  status: string;
  worker: { state: string; error?: string };
};
export type CrabboxAttachment = { environmentId: string };
export type CrabboxProfile = {
  id: string;
  providerId: string;
  machines?: WorkerMachineOption[];
  operatingSystems?: Array<{ id: string; disabledReason?: string }>;
};
export type CrabboxExecResult = SpawnResult & {
  environmentId: string;
  workspaceDir: string;
  process?: { processId: string; state: "running" | "exited" };
};

export function crabboxProfilesResult(result: {
  profiles: Array<CrabboxProfile & { desktop: boolean }>;
}) {
  const lines = result.profiles.map((profile) => {
    const choices = [
      profile.desktop ? "desktop enabled" : "desktop disabled",
      ...(profile.operatingSystems?.map((os) =>
        os.disabledReason ? `${os.id} (unavailable: ${os.disabledReason})` : os.id,
      ) ?? []),
      ...(profile.machines?.map(
        (machine) => `${machine.id}${machine.os ? ` (${machine.os})` : ""}`,
      ) ?? []),
    ];
    return `- ${profile.id}: ${choices.join("; ")}`;
  });
  return textResult(
    lines.length
      ? `Crabbox profiles:\n${lines.join("\n")}\nUse action=create with a profileId to create or reuse a Crabbox.`
      : "No Crabbox profiles are currently available.",
    result,
  );
}

export function crabboxEnvironmentText(environment: CrabboxEnvironment): string {
  return `Environment: ${environment.status} (${environment.worker.state}).${environment.worker.error ? `\n${environment.worker.error}` : ""}`;
}

export function crabboxExecResult(result: CrabboxExecResult) {
  const process = result.process;
  const summary = process
    ? `Process ${process.processId}: ${process.state}.` +
      (process.state === "running" ? " App readiness has not been checked." : "")
    : result.code === 0 && result.termination === "exit"
      ? "Command completed."
      : "Command failed.";
  const lines = [
    summary,
    `exit code: ${result.code}; termination: ${result.termination}; signal: ${result.signal}; killed: ${result.killed}`,
    `Environment: ${result.environmentId}; workspace: ${result.workspaceDir}`,
  ];
  if (result.stdoutTruncatedBytes) {
    lines.push(`stdout truncated: ${result.stdoutTruncatedBytes} bytes`);
  }
  if (result.stderrTruncatedBytes) {
    lines.push(`stderr truncated: ${result.stderrTruncatedBytes} bytes`);
  }
  if (result.outputLimitExceeded) {
    lines.push(
      `Output limit exceeded${result.outputErrorStream ? ` (${result.outputErrorStream})` : ""}.`,
    );
  }
  // Keep output bytes intact; Code Mode also consumes the unchanged structured receipt.
  return textResult(
    `${lines.join("\n")}\n\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    result,
  );
}
