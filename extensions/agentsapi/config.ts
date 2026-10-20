import { createHash } from "node:crypto";
import path from "node:path";
import type { AgentToolParam, EnvironmentParam } from "openai/resources/beta/agents/agents";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { z } from "zod";

export const DEFAULT_NATIVE_TOOLS = [
  { type: "web_search", mode: "live" },
  { type: "programmatic_tool_calling", enabled: true },
] satisfies AgentToolParam[];

export const agentsApiConfigSchema = z.strictObject({
  nativeTools: z.array(z.looseObject({ type: z.string().min(1) })).default(DEFAULT_NATIVE_TOOLS),
  forwarding: z
    .strictObject({
      gatewayTools: z.boolean().default(true),
      mcpServers: z.boolean().default(true),
    })
    .default({ gatewayTools: true, mcpServers: true }),
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
  // Recognize retired configuration so repair cannot silently discard its owner.
  executorController: z
    .never({
      error:
        "Agents API executorController is no longer supported. Retire controlled sessions with the previous OpenClaw version and original controller plugin, then remove executorController and configure an external executor lifecycle owner before upgrading.",
    })
    .optional(),
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

/** Immutable native configuration must match before resuming a retained binding. */
export function requireAgentsApiSessionFingerprint({
  existingFingerprint,
  model,
  environment,
  mcpTools,
  webSearchEnabled,
  forwarding,
}: {
  existingFingerprint?: string;
  model: string;
  environment: AgentsApiEnvironment;
  mcpTools: AgentToolParam.AgentToolConfigParamMcp[];
  webSearchEnabled: boolean;
  forwarding: AgentsApiConfig["forwarding"];
}): string {
  const identity = [
    model,
    // Preserve existing hosted identities only when no network policy is configured.
    ...(environment.type === "self_hosted" || environment.network != null ? [environment] : []),
    ...(mcpTools.length ? [mcpTools] : []),
    // Legacy bindings have no restriction marker; never assume their tools are disabled.
    ...(!webSearchEnabled ? [{ webSearch: false }] : []),
    // Default forwarding keeps the exact legacy identity, including when explicitly enabled.
    ...(!forwarding.gatewayTools || !forwarding.mcpServers ? [{ forwarding }] : []),
  ];
  const fingerprint = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  if (existingFingerprint && existingFingerprint !== fingerprint) {
    throw new Error(
      "Agents API model, environment, MCP, web-search, or forwarding policy changed; reset the OpenClaw session before continuing",
    );
  }
  return fingerprint;
}

export function resolveAgentsApiNativeToolPolicy(
  params: Pick<AgentHarnessAttemptParamsV2, "config" | "toolOverrides">,
  pluginConfig: AgentsApiConfig,
) {
  const webSearchEnabled =
    params.config?.tools?.web?.search?.enabled !== false &&
    params.toolOverrides?.webSearch !== false;
  return {
    webSearchEnabled,
    nativeTools: webSearchEnabled
      ? pluginConfig.nativeTools
      : pluginConfig.nativeTools.filter((tool) => tool.type !== "web_search"),
  };
}
