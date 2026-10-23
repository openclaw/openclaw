/** Composes the child environment and authorizes retained Claude transcript locations. */
import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSkillEnvOverridesFromSnapshot } from "../../skills/runtime/env-overrides.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { resolveAgentRunCwd, resolveAgentWorkspaceDir } from "../agent-scope-config.js";
import { resolveCliBackendConfig } from "../cli-backends.js";
import {
  resolveClaudeCliProjectsRoot,
  resolveClaudeCliProjectsRootAsync,
} from "../command/claude-cli-project-dir.js";
import { resolveCliChildEnv } from "./execution-env.js";
import { isClaudeCliBackendId } from "./helpers.js";

export type CliChildEnv = {
  env: Record<string, string>;
  /** Backend keys cleared because prepared Claude auth owns them. */
  selectedClaudeClearEnv?: ReadonlySet<string>;
  /** Claude projects root the child writes transcripts into, when it runs on this host. */
  claudeTranscriptRoot?: string;
};

type CliChildEnvParams = {
  provider: string;
  preparedBackend: Parameters<typeof resolveCliChildEnv>[0];
  /** Late execution-only overlays; preparation composes the same child env without them. */
  overlays?: readonly (Record<string, string> | undefined)[];
  /** Pure skill snapshot overlay used before execution applies its scoped process env. */
  skillEnv?: Readonly<Record<string, string>>;
  remote: boolean;
  cwd: string;
};

function composeCliChildEnv(
  params: Pick<CliChildEnvParams, "preparedBackend" | "overlays" | "skillEnv">,
): CliChildEnv {
  const { env, selectedClaudeClearEnv } = resolveCliChildEnv(params.preparedBackend, {
    skillEnv: params.skillEnv,
  });
  Object.assign(env, ...(params.overlays ?? []));
  // Never mark Claude CLI as host-managed. That marker routes runs into
  // Anthropic's separate host-managed usage tier instead of normal CLI use.
  delete env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST;
  return { env, ...(selectedClaudeClearEnv ? { selectedClaudeClearEnv } : {}) };
}

export async function buildCliChildEnv(params: CliChildEnvParams): Promise<CliChildEnv> {
  const child = composeCliChildEnv(params);
  // Transcript discovery must follow the environment this child actually receives,
  // not the Gateway's own. A paired node writes its transcript on that node.
  const claudeTranscriptRoot =
    isClaudeCliBackendId(params.provider) && !params.remote
      ? await resolveClaudeCliProjectsRootAsync({ env: child.env, cwd: params.cwd })
      : undefined;
  return {
    ...child,
    ...(claudeTranscriptRoot ? { claudeTranscriptRoot } : {}),
  };
}

/** Retained paths locate history; only the current environment authorizes reading it. */
export function resolveAuthorizedClaudeCliBinding(params: {
  entry: SessionEntry | undefined;
  config?: OpenClawConfig;
  agentId?: string;
  skillsSnapshot?: SkillSnapshot;
  cwd?: string;
  homeDir?: string;
}) {
  const binding = getCliSessionBinding(params.entry, "claude-cli");
  // Node placement owns native files on that node, including rootless bindings.
  if (!binding || params.entry?.execHost === "node") {
    return undefined;
  }
  const config = params.config ?? getRuntimeConfigSnapshot() ?? undefined;
  const backend = resolveCliBackendConfig("claude-cli", config, { agentId: params.agentId });
  const child = composeCliChildEnv({
    // History must not rerun effectful per-turn preparation or treat a past
    // prepared override as present authority. Unselected roots fail closed.
    preparedBackend: { backend: backend?.config ?? {} },
    skillEnv: resolveSkillEnvOverridesFromSnapshot({
      snapshot: params.skillsSnapshot ?? params.entry?.skillsSnapshot,
      config,
    }),
  });
  const currentRoot = resolveClaudeCliProjectsRoot({
    env: child.env,
    homeDir: params.homeDir,
    // Current child cwd authorizes relative roots. The binding's historical cwd
    // only locates files after authorization; it must not keep a former root selected.
    cwd:
      params.cwd ??
      (params.agentId && config
        ? (params.entry?.spawnedCwd ??
          resolveAgentRunCwd(config, params.agentId) ??
          params.entry?.spawnedWorkspaceDir ??
          resolveAgentWorkspaceDir(config, params.agentId))
        : undefined),
  });
  return currentRoot && (!binding.transcriptRoot || binding.transcriptRoot === currentRoot)
    ? { ...binding, transcriptRoot: currentRoot }
    : undefined;
}

/** Resolves the transcript root the next child will use, before its process starts. */
export async function resolveClaudeChildTranscriptRoot(
  params: Omit<CliChildEnvParams, "overlays">,
): Promise<string | undefined> {
  return (await buildCliChildEnv(params)).claudeTranscriptRoot;
}

/** Projects the location a Claude binding must retain so later lookups skip Gateway state. */
export function claudeCliBindingLocation(
  provider: string,
  context: { cwd?: string; claudeTranscriptRoot?: string },
): { cwd?: string; transcriptRoot?: string } {
  if (!isClaudeCliBackendId(provider)) {
    return {};
  }
  return {
    ...(context.cwd ? { cwd: context.cwd } : {}),
    ...(context.claudeTranscriptRoot ? { transcriptRoot: context.claudeTranscriptRoot } : {}),
  };
}
