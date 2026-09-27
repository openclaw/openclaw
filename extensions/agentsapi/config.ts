import path from "node:path";
import type { EnvironmentParam } from "openai/resources/beta/agents/agents";
import { z } from "zod";

export const agentsApiConfigSchema = z.strictObject({
  environment: z.enum(["openai_hosted", "self_hosted"]).default("openai_hosted"),
  hostExecutorSkillDirectories: z
    .array(
      z
        .string()
        .regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/)
        .refine(
          (directory) =>
            !directory
              .split(directory.startsWith("/") ? "/" : /[\\/]/)
              .some((segment) => segment === "." || segment === ".."),
          "Executor skill directories cannot contain . or .. path segments",
        ),
    )
    .max(32)
    .refine(
      (directories) => new Set(directories).size === directories.length,
      "Executor skill directories must be unique",
    )
    .optional(),
});

export type AgentsApiEnvironment =
  | EnvironmentParam.EnvironmentParamOpenAIHosted
  | EnvironmentParam.EnvironmentParamSelfHosted;

export function resolveAgentsApiEnvironment(
  pluginConfig: unknown,
  workspaceDir: string,
): AgentsApiEnvironment {
  const parsed = agentsApiConfigSchema.parse(pluginConfig ?? {});
  return parsed.environment === "self_hosted"
    ? {
        type: "self_hosted",
        workspace_directory: path.resolve(workspaceDir),
        ...(parsed.hostExecutorSkillDirectories?.length
          ? { capability_directories: parsed.hostExecutorSkillDirectories }
          : {}),
      }
    : { type: "openai_hosted" };
}
