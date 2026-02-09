/**
 * Coder agent — handles code editing, testing, and deployment.
 * Uses cloud model for complex code. Shell tool for execution.
 */

import type { Task } from "../types.js";
import { BaseAgent, type AgentResult } from "./base-agent.js";
import { execShell, requiresApproval as shellRequiresApproval } from "../tools/shell.js";
import { checkShellSafety } from "../security/guards.js";

export class CoderAgent extends BaseAgent {
  async execute(task: Task): Promise<AgentResult> {
    return this.runWithTracking(task, async () => {
      const { intent } = task.classification;

      switch (intent) {
        case "code_simple":
        case "code_complex":
          return this.code(task);
        case "deploy":
          return this.deploy(task);
        default:
          return this.code(task);
      }
    });
  }

  private async code(task: Task): Promise<string> {
    // Ask the model to produce code or shell commands
    const prompt = [
      "You are a coding assistant. Help with the following task.",
      "If the task requires running commands, output them as:",
      "```bash",
      "command here",
      "```",
      "If it requires writing code, output the code with the file path:",
      "```filepath:/path/to/file",
      "code here",
      "```",
      "Explain your approach briefly, then provide the solution.",
      "",
      `Task: ${task.input}`,
    ].join("\n");

    const response = await this.callModel(task, prompt);

    // Extract and run any bash commands from the response
    const bashBlocks = [...response.matchAll(/```bash\n([\s\S]*?)```/g)];

    if (bashBlocks.length > 0) {
      const outputs: string[] = [response, "", "--- Execution Results ---"];

      for (const block of bashBlocks) {
        const command = block[1].trim();

        // Security: check for dangerous patterns in model-generated commands
        const safetyCheck = checkShellSafety(command);
        if (safetyCheck) {
          outputs.push(`\n> \`${command}\` — BLOCKED: ${safetyCheck}`);
          await this.audit({
            action: "shell_blocked",
            tool: "shell",
            input: { command },
            error: safetyCheck,
          });
          continue;
        }

        if (shellRequiresApproval(command)) {
          outputs.push(`\n> \`${command}\` — skipped (requires approval)`);
          continue;
        }

        await this.audit({
          action: "shell_exec",
          tool: "shell",
          input: { command },
        });

        const result = await execShell(command, {
          cwd: this.deps.projectRoot,
          timeoutMs: 60_000,
        });

        if (result.exitCode === 0) {
          outputs.push(`\n> \`${command}\` — OK (${result.durationMs}ms)`);
          if (result.stdout.trim()) {
            outputs.push(result.stdout.trim());
          }
        } else {
          outputs.push(`\n> \`${command}\` — FAILED (exit ${result.exitCode})`);
          if (result.stderr.trim()) {
            outputs.push(result.stderr.trim());
          }
        }
      }

      return outputs.join("\n");
    }

    return response;
  }

  private async deploy(task: Task): Promise<string> {
    // Generate a deployment plan
    const planPrompt = [
      "Create a deployment plan for the following request.",
      "List the exact commands to run, in order.",
      "Include pre-flight checks (tests, build, lint).",
      "Format each command as: STEP N: description",
      "```bash",
      "command",
      "```",
      "",
      `Request: ${task.input}`,
    ].join("\n");

    const plan = await this.callModel(task, planPrompt, { maxTokens: 2000 });

    await this.audit({
      action: "deploy_plan",
      tool: "shell",
      output: plan.slice(0, 300),
    });

    return `Deployment plan ready (requires your approval before execution):\n\n${plan}`;
  }
}
