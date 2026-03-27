import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

const execAsync = promisify(exec);

const MCPORTER_TIMEOUT_MS = 600_000; // 10 minutes — matches server-side asyncio.wait_for
const MCPORTER_FALLBACK_PATH = `${process.env.HOME}/.npm-global/bin/mcporter`;

const RunWorkflowSchema = Type.Object({
  name: Type.String({
    description:
      "Workflow name to run (e.g. delegate_run, judge_run, critique_run, distribute_run, effectiveness_run, lessons_writer, optus_run)",
  }),
  inputs: Type.Optional(
    Type.String({
      description: "JSON string of workflow inputs (default: '{}')",
    }),
  ),
});

function escapeShellArg(arg: string): string {
  return arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function resolveMcporterPath(): Promise<string> {
  try {
    const { stdout } = await execAsync("which mcporter", { timeout: 5000 });
    const path = stdout.trim();
    if (path) return path;
  } catch {
    // fall through
  }
  return MCPORTER_FALLBACK_PATH;
}

const workflowsPlugin = {
  id: "workflows",
  name: "Workflows (LangGraph)",
  description: "Native agent tool for invoking LangGraph workflows via mcporter",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerTool(
      (_ctx) => {
        return {
          label: "Workflows",
          name: "run_workflow",
          description:
            "Run a LangGraph workflow by name. Returns the workflow result as JSON. " +
            "Available workflows: delegate_run (delegation planning), judge_run (learning judge), " +
            "critique_run (self-critique), distribute_run (lesson distribution), " +
            "effectiveness_run (effectiveness calculator), lessons_writer (write LESSONS.md to workspaces), " +
            "optus_run (self-optimizer), optus_rollback (rollback a change), lesson_status (read-only query).",
          parameters: RunWorkflowSchema,
          execute: async (_toolCallId: string, args: Record<string, unknown>) => {
            const params = args;
            const name = typeof params.name === "string" ? params.name.trim() : "";
            if (!name) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({ error: "name parameter is required" }),
                  },
                ],
                details: undefined,
              };
            }

            const inputs = typeof params.inputs === "string" ? params.inputs.trim() : "{}";

            try {
              const mcporter = await resolveMcporterPath();
              // Pass --timeout to mcporter CLI (its default is 60s which is too short for long workflows like optus/judge)
              const argsJson = JSON.stringify({ name, inputs });
              const command = `${mcporter} call workflows.run_workflow --timeout ${MCPORTER_TIMEOUT_MS} --args '${argsJson.replace(/'/g, "'\\''")}'`;

              const { stdout, stderr } = await execAsync(command, {
                timeout: MCPORTER_TIMEOUT_MS,
                maxBuffer: 10 * 1024 * 1024,
              });

              if (stderr && !stderr.includes("warn")) {
                api.logger.debug?.(`mcporter stderr: ${stderr.slice(0, 500)}`);
              }

              // Try to parse as JSON for structured output
              try {
                const parsed = JSON.parse(stdout);
                return {
                  content: [{ type: "text" as const, text: JSON.stringify(parsed, null, 2) }],
                  details: parsed,
                };
              } catch {
                // Return raw output if not JSON
                return {
                  content: [{ type: "text" as const, text: stdout.slice(0, 50000) }],
                  details: undefined,
                };
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              api.logger.error(`run_workflow failed: ${message}`);

              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      error: `Workflow execution failed: ${message.slice(0, 2000)}`,
                      workflow: name,
                      status: "failed",
                    }),
                  },
                ],
                details: undefined,
              };
            }
          },
        };
      },
      { names: ["run_workflow"] },
    );
  },
};

export default workflowsPlugin;

/** @internal — exported for unit tests only */
export const __testing = { escapeShellArg };
