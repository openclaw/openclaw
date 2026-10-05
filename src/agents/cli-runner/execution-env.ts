import { sanitizeHostExecEnv } from "../../infra/host-env-security.js";
import {
  getInstallationTarget,
  installationTargetEnv,
} from "../../infra/installation-target-context.js";
import {
  CLAUDE_SELECTED_AUTH_ENV_KEYS,
  CLI_BACKEND_PRESERVE_ENV,
  parseCliBackendPreserveEnv,
} from "./execute-logging.js";
import type { PreparedCliRunContext } from "./types.js";

type ChildEnvBackend = Pick<
  PreparedCliRunContext["preparedBackend"],
  "backend" | "env" | "secretInput"
>;

/**
 * The environment a local CLI child starts from: the Gateway process, minus the backend's
 * clearEnv, plus backend and prepared overrides. Preparation and execution both call this,
 * so what a history owner is derived from is the environment the child actually receives.
 * Per-attempt MCP capture variables are layered on by the executor and never carry identity.
 */
export function resolveCliChildEnv(
  preparedBackend: ChildEnvBackend,
  baseEnv: NodeJS.ProcessEnv = process.env,
): { env: Record<string, string>; selectedClaudeClearEnv: Set<string> | undefined } {
  const { backend } = preparedBackend;
  const preparedBackendEnv = preparedBackend.env ?? {};
  const hasSelectedClaudeAuth =
    Boolean(preparedBackend.secretInput) ||
    [...CLAUDE_SELECTED_AUTH_ENV_KEYS].some((key) => Object.hasOwn(preparedBackendEnv, key));
  const selectedClaudeClearEnv = hasSelectedClaudeAuth
    ? new Set(backend.clearEnv ?? [])
    : undefined;
  const configuredBackendEnv = Object.fromEntries(
    Object.entries(backend.env ?? {}).filter(([key]) => !selectedClaudeClearEnv?.has(key)),
  );
  const backendEnv = { ...configuredBackendEnv, ...preparedBackendEnv };
  const env = sanitizeHostExecEnv({ baseEnv, blockPathOverrides: true });
  const preservedEnv = parseCliBackendPreserveEnv(baseEnv[CLI_BACKEND_PRESERVE_ENV]);
  for (const key of backend.clearEnv ?? []) {
    if (!preservedEnv.has(key) || selectedClaudeClearEnv?.has(key)) {
      delete env[key];
    }
  }
  if (Object.keys(backendEnv).length > 0) {
    Object.assign(
      env,
      sanitizeHostExecEnv({
        baseEnv: {},
        overrides: backendEnv,
        blockPathOverrides: true,
      }),
    );
  }
  Object.assign(env, installationTargetEnv(getInstallationTarget()));
  return { env, selectedClaudeClearEnv };
}
