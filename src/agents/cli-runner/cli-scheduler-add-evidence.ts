// Scheduler add evidence extracted from cli-runner/execute-tool-tracking.ts to keep
// that module under its line cap. Mirrors the embedded-runtime canonical pattern:
// isAutomationsToolName(stripped) && isCronAddAction(args) && outcome === "completed".
import { isCronAddAction } from "../harness/tool-result-facts.js";
import { isAutomationsToolName } from "../tools/automations-tool-name.js";

/**
 * Whether a completed CLI tool result represents a successful scheduler (automations
 * or cron alias) add this turn. The reminder guard reads successfulCronAdds to decide
 * whether to append the "I did not schedule a reminder" note; the CLI runtime must
 * mirror the embedded-runtime contract so an add over MCP is counted.
 */
export function isSuccessfulCliSchedulerAdd(params: {
  outcome: string;
  toolName: string;
  args: Record<string, unknown>;
}): boolean {
  return (
    params.outcome === "completed" &&
    isAutomationsToolName(params.toolName) &&
    isCronAddAction(params.args)
  );
}

/**
 * Mutable counter for successful scheduler adds this turn. The CLI runtime records
 * each completed automations/cron add; the counter is then projected into CliOutput
 * and the settled AgentRunResult so the reminder guard sees successfulCronAdds >= 1.
 */
export function createSuccessfulCronAddCounter() {
  let successfulCronAdds = 0;
  return {
    record(params: { outcome: string; toolName: string; args: Record<string, unknown> }): void {
      if (isSuccessfulCliSchedulerAdd(params)) {
        successfulCronAdds += 1;
      }
    },
    get value(): number {
      return successfulCronAdds;
    },
    /** Spread into CliOutput when non-zero. */
    project(): { successfulCronAdds: number } | Record<string, never> {
      return successfulCronAdds > 0 ? { successfulCronAdds } : {};
    },
  };
}
