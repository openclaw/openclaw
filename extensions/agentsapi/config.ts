import path from "node:path";
import type { EnvironmentParam } from "openai/resources/beta/agents/agents";
import { z } from "zod";

export const agentsApiConfigSchema = z.strictObject({
  environment: z.enum(["openai_hosted", "self_hosted"]).default("openai_hosted"),
});

export type AgentsApiConfig = z.infer<typeof agentsApiConfigSchema>;
export type AgentsApiEnvironment =
  | EnvironmentParam.EnvironmentParamOpenAIHosted
  | EnvironmentParam.EnvironmentParamSelfHosted;

export function resolveAgentsApiEnvironment(
  pluginConfig: unknown,
  workspaceDir: string,
): AgentsApiEnvironment {
  const parsed = agentsApiConfigSchema.parse(pluginConfig ?? {});
  return parsed.environment === "self_hosted"
    ? { type: "self_hosted", workspace_directory: path.resolve(workspaceDir) }
    : { type: "openai_hosted" };
}
