import { createLLMClientFromEnv, createOrchestrator } from "../../../src/codegen/index.js";
import type { GenerationTask, UserRequest } from "../../../src/codegen/types.js";

export type GenerationType = "web" | "api" | "mobile" | "desktop" | "cli";

export interface GenerationInput {
  description: string;
  type: GenerationType;
  tech_stack?: string[];
}

function assertValidInput(input: GenerationInput): void {
  if (!input.description.trim()) {
    throw new Error("description is required");
  }

  const validTypes: GenerationType[] = ["web", "api", "mobile", "desktop", "cli"];
  if (!validTypes.includes(input.type)) {
    throw new Error("type is invalid");
  }
}

function toUserRequest(input: GenerationInput): UserRequest {
  return {
    description: input.description,
    type: input.type,
    constraints: input.tech_stack?.length ? { tech_stack: input.tech_stack } : undefined,
    user_id: "web_user",
    request_id: `req_${Date.now()}`,
  };
}

export async function createGenerationTask(input: GenerationInput): Promise<GenerationTask> {
  assertValidInput(input);

  const llmClient = createLLMClientFromEnv();
  const orchestrator = createOrchestrator(llmClient, {
    stages: {
      pm: true,
      architect: false,
      coding: false,
      review: false,
      test: false,
      deploy: false,
    },
  });

  const request = toUserRequest(input);
  const task = orchestrator.createTask(request);

  return orchestrator.executeTask(task.task_id);
}
