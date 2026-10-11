/** Composes the child environment and authorizes retained Claude transcript locations. */
import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sanitizeHostExecEnv } from "../../infra/host-env-security.js";
import { resolveSkillEnvOverridesFromSnapshot } from "../../skills/runtime/env-overrides.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { resolveAgentRunCwd, resolveAgentWorkspaceDir } from "../agent-scope-config.js";
import { resolveCliBackendConfig } from "../cli-backends.js";
import {
  resolveClaudeCliProjectsRoot,
  resolveClaudeCliProjectsRootAsync,
} from "../command/claude-cli-project-dir.js";
import {
  CLAUDE_SELECTED_AUTH_ENV_KEYS,
  CLI_BACKEND_PRESERVE_ENV,
  parseCliBackendPreserveEnv,
} from "./execute-logging.js";
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
  backend: { env?: Record<string, string>; clearEnv?: readonly string[] };
  preparedBackend: { env?: Record<string, string>; secretInput?: unknown };
  /** Late execution-only overlays; preparation composes the same child env without them. */
  overlays?: readonly (Record<string, string> | undefined)[];
  /** Pure skill snapshot overlay used before execution applies its scoped process env. */
  skillEnv?: Readonly<Record<string, string>>;
  remote: boolean;
  cwd: string;
};

function composeCliChildEnv(
  params: Pick<CliChildEnvParams, "backend" | "preparedBackend" | "overlays" | "skillEnv">,
): CliChildEnv {
  const preparedBackendEnv = params.preparedBackend.env ?? {};
  const hasSelectedClaudeAuth =
    Boolean(params.preparedBackend.secretInput) ||
    [...CLAUDE_SELECTED_AUTH_ENV_KEYS].some((key) => Object.hasOwn(preparedBackendEnv, key));
  const selectedClaudeClearEnv = hasSelectedClaudeAuth
    ? new Set(params.backend.clearEnv ?? [])
    : undefined;
  const backendEnv = {
    ...Object.fromEntries(
      Object.entries(params.backend.env ?? {}).filter(([key]) => !selectedClaudeClearEnv?.has(key)),
    ),
    ...preparedBackendEnv,
  };
  const env = sanitizeHostExecEnv({ baseEnv: process.env, blockPathOverrides: true });
  if (params.skillEnv) {
    Object.assign(
      env,
      sanitizeHostExecEnv({
        baseEnv: {},
        overrides: params.skillEnv,
        blockPathOverrides: true,
      }),
    );
  }
  const preservedEnv = parseCliBackendPreserveEnv(process.env[CLI_BACKEND_PRESERVE_ENV]);
  for (const key of params.backend.clearEnv ?? []) {
    if (!preservedEnv.has(key) || selectedClaudeClearEnv?.has(key)) {
      delete env[key];
    }
  }
  if (Object.keys(backendEnv).length > 0) {
    Object.assign(
      env,
      sanitizeHostExecEnv({ baseEnv: {}, overrides: backendEnv, blockPathOverrides: true }),
    );
  }
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
    backend: backend?.config ?? {},
    // History must not rerun effectful per-turn preparation or treat a past
    // prepared override as present authority. Unselected roots fail closed.
    preparedBackend: {},
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
