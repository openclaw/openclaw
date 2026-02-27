/**
 * Lobster Workflow Tool
 *
 * Provides typed pipeline execution with resumable human-approval gates.
 * Pipelines are defined as DAGs of steps; each step can optionally require
 * human approval before continuing.  State is persisted to disk so that
 * long-running pipelines survive process restarts.
 */

import type { BotPluginApi } from "bot/plugin-sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Pipeline types ───────────────────────────────────────────────────────────

export type PipelineStepStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "completed"
  | "failed";

interface PipelineStep {
  id: string;
  label: string;
  status: PipelineStepStatus;
  requiresApproval: boolean;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

interface Pipeline {
  id: string;
  name: string;
  steps: PipelineStep[];
  createdAt: string;
  updatedAt: string;
  status: "active" | "completed" | "failed" | "paused";
}

// ── State persistence ────────────────────────────────────────────────────────

function resolvePipelinesDir(api: BotPluginApi): string {
  const dir = api.resolvePath("~/.hanzo/bot/lobster/pipelines");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function loadPipeline(dir: string, id: string): Pipeline | null {
  const filePath = join(dir, `${id}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as Pipeline;
  } catch {
    return null;
  }
}

function savePipeline(dir: string, pipeline: Pipeline): void {
  pipeline.updatedAt = new Date().toISOString();
  writeFileSync(join(dir, `${pipeline.id}.json`), JSON.stringify(pipeline, null, 2));
}

// ── Tool implementation ──────────────────────────────────────────────────────

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

export function createLobsterTool(api: BotPluginApi) {
  const pipelinesDir = resolvePipelinesDir(api);

  return {
    name: "lobster_workflow",
    label: "Lobster Workflow",
    description:
      "Manage typed workflow pipelines with resumable human-approval gates. " +
      "Actions: create (new pipeline), status (inspect pipeline), approve/reject (gate step), " +
      "advance (run next pending step), list (show all pipelines).",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["create", "status", "approve", "reject", "advance", "list"],
          description:
            "create: create a new pipeline with steps. status: view pipeline state. " +
            "approve/reject: act on an awaiting_approval step. advance: run next pending step. " +
            "list: show all pipelines.",
        },
        pipeline_id: {
          type: "string",
          description: "Pipeline ID (required for status, approve, reject, advance)",
        },
        step_id: {
          type: "string",
          description: "Step ID (required for approve/reject)",
        },
        name: {
          type: "string",
          description: "Pipeline name (for create)",
        },
        steps: {
          type: "string",
          description:
            'JSON array of step definitions for create, e.g. [{"id":"build","label":"Build","requiresApproval":false}]',
        },
      },
      required: ["action"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const action = params.action as string;

      switch (action) {
        case "list": {
          const { readdirSync } = await import("node:fs");
          const files = readdirSync(pipelinesDir).filter((f) => f.endsWith(".json"));
          if (files.length === 0) return textResult("No pipelines found.");
          const summaries = files.map((f) => {
            const p = loadPipeline(pipelinesDir, f.replace(".json", ""));
            if (!p) return `- (unreadable: ${f})`;
            const pending = p.steps.filter((s) => s.status === "awaiting_approval").length;
            return `- **${p.name}** (${p.id}) — ${p.status}${pending > 0 ? `, ${pending} awaiting approval` : ""}`;
          });
          return textResult(summaries.join("\n"));
        }

        case "create": {
          const name = typeof params.name === "string" ? params.name.trim() : "Untitled Pipeline";
          let stepDefs: Array<{ id: string; label: string; requiresApproval?: boolean }>;
          try {
            stepDefs = typeof params.steps === "string" ? JSON.parse(params.steps) : [];
          } catch {
            return textResult("Invalid steps JSON.");
          }
          if (!Array.isArray(stepDefs) || stepDefs.length === 0) {
            return textResult("Provide at least one step definition.");
          }
          const id = `pipeline-${Date.now().toString(36)}`;
          const pipeline: Pipeline = {
            id,
            name,
            steps: stepDefs.map((s) => ({
              id: s.id,
              label: s.label ?? s.id,
              status: "pending" as const,
              requiresApproval: s.requiresApproval ?? false,
            })),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: "active",
          };
          savePipeline(pipelinesDir, pipeline);
          return textResult(
            `Pipeline **${name}** created with ${pipeline.steps.length} steps (id: ${id}).`,
          );
        }

        case "status": {
          const pipelineId = typeof params.pipeline_id === "string" ? params.pipeline_id : "";
          const pipeline = loadPipeline(pipelinesDir, pipelineId);
          if (!pipeline) return textResult(`Pipeline "${pipelineId}" not found.`);
          const lines = [
            `## ${pipeline.name} (${pipeline.status})`,
            "",
            ...pipeline.steps.map(
              (s) =>
                `- **${s.label}** [${s.status}]${s.output ? ` — ${s.output}` : ""}${s.error ? ` ERROR: ${s.error}` : ""}`,
            ),
          ];
          return textResult(lines.join("\n"));
        }

        case "approve":
        case "reject": {
          const pipelineId = typeof params.pipeline_id === "string" ? params.pipeline_id : "";
          const stepId = typeof params.step_id === "string" ? params.step_id : "";
          const pipeline = loadPipeline(pipelinesDir, pipelineId);
          if (!pipeline) return textResult(`Pipeline "${pipelineId}" not found.`);
          const step = pipeline.steps.find((s) => s.id === stepId);
          if (!step) return textResult(`Step "${stepId}" not found in pipeline.`);
          if (step.status !== "awaiting_approval") {
            return textResult(
              `Step "${stepId}" is not awaiting approval (current: ${step.status}).`,
            );
          }
          step.status = action === "approve" ? "approved" : "rejected";
          step.completedAt = new Date().toISOString();
          if (action === "reject") {
            pipeline.status = "failed";
            step.error = "Rejected by user";
          }
          savePipeline(pipelinesDir, pipeline);
          return textResult(`Step **${step.label}** ${action}d.`);
        }

        case "advance": {
          const pipelineId = typeof params.pipeline_id === "string" ? params.pipeline_id : "";
          const pipeline = loadPipeline(pipelinesDir, pipelineId);
          if (!pipeline) return textResult(`Pipeline "${pipelineId}" not found.`);
          if (pipeline.status !== "active") {
            return textResult(`Pipeline is ${pipeline.status}, cannot advance.`);
          }
          const nextStep = pipeline.steps.find(
            (s) => s.status === "pending" || s.status === "approved",
          );
          if (!nextStep) {
            pipeline.status = "completed";
            savePipeline(pipelinesDir, pipeline);
            return textResult("All steps completed. Pipeline finished.");
          }
          if (nextStep.requiresApproval && nextStep.status === "pending") {
            nextStep.status = "awaiting_approval";
            savePipeline(pipelinesDir, pipeline);
            return textResult(
              `Step **${nextStep.label}** requires approval. Use approve/reject with step_id="${nextStep.id}".`,
            );
          }
          nextStep.status = "running";
          nextStep.startedAt = new Date().toISOString();
          // Simulate step execution (real pipelines would dispatch actual work)
          nextStep.status = "completed";
          nextStep.completedAt = new Date().toISOString();
          nextStep.output = "Step completed successfully.";
          savePipeline(pipelinesDir, pipeline);
          return textResult(`Step **${nextStep.label}** completed.`);
        }

        default:
          return textResult(`Unknown action: ${action}`);
      }
    },
  };
}
