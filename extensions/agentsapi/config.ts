import path from "node:path";
import type { AgentToolParam, EnvironmentParam } from "openai/resources/beta/agents/agents";
import { z } from "zod";

export const DEFAULT_NATIVE_TOOLS = [
  { type: "web_search", mode: "live" },
  { type: "programmatic_tool_calling", enabled: true },
] satisfies AgentToolParam[];

export const agentsApiConfigSchema = z.strictObject({
  nativeTools: z.array(z.looseObject({ type: z.string().min(1) })).default(DEFAULT_NATIVE_TOOLS),
  plugins: z
    .strictObject({
      enabled: z.boolean().optional(),
      allow_all_plugins: z.boolean().optional(),
      plugins: z
        .record(
          z.string(),
          z.strictObject({
            enabled: z.boolean().optional(),
            marketplaceName: z
              .string()
              .regex(/^[A-Za-z0-9_-]+$/)
              .optional(),
            pluginName: z.string().trim().min(1).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  environment: z.enum(["openai_hosted", "self_hosted"]).default("openai_hosted"),
  executorController: z.string().trim().min(1).optional(),
  openai_host: z
    .strictObject({
      network: z
        .strictObject({
          access: z.enum(["enabled", "disabled", "restricted"]),
          allowed_domains: z.array(z.string()).nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
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

export type AgentsApiConfig = z.infer<typeof agentsApiConfigSchema>;

export type AgentsApiEnvironment =
  | EnvironmentParam.EnvironmentParamOpenAIHosted
  | EnvironmentParam.EnvironmentParamSelfHosted;

export function resolveAgentsApiEnvironment(
  parsed: AgentsApiConfig,
  workspaceDir: string,
): AgentsApiEnvironment {
  return parsed.environment === "self_hosted"
    ? {
        type: "self_hosted",
        workspace_directory: path.resolve(workspaceDir),
        ...(parsed.hostExecutorSkillDirectories?.length
          ? { capability_directories: parsed.hostExecutorSkillDirectories }
          : {}),
      }
    : {
        type: "openai_hosted",
        ...(parsed.openai_host?.network !== undefined
          ? { network: parsed.openai_host.network }
          : {}),
      };
}
