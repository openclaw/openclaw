import { sanitizeHostExecEnv } from "../../infra/host-env-security.js";
import {
  CLAUDE_SELECTED_AUTH_ENV_KEYS,
  CLI_BACKEND_PRESERVE_ENV,
  parseCliBackendPreserveEnv,
} from "./execute-logging.js";
import type { PreparedCliRunContext } from "./types.js";

type ChildEnvBackend = Pick<PreparedCliRunContext["preparedBackend"], "env" | "secretInput"> & {
  /** Only `env` and `clearEnv` shape the child; history readers compose without a command. */
  backend: Partial<PreparedCliRunContext["preparedBackend"]["backend"]>;
};

/**
 * The environment a local CLI child starts from: the Gateway process, minus the backend's
 * clearEnv, plus backend and prepared overrides. Preparation and execution both call this,
 * so what a history owner is derived from is the environment the child actually receives.
 * The executor layers per-attempt MCP capture and installation target variables on top; those
 * never carry identity.
 */
export function resolveCliChildEnv(
  preparedBackend: ChildEnvBackend,
  options?: {
    /** Skill snapshot overrides projected without mutating the Gateway process environment. */
    skillEnv?: Readonly<Record<string, string>>;
  },
): {
  env: Record<string, string>;
  selectedClaudeClearEnv: Set<string> | undefined;
} {
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
  const env = sanitizeHostExecEnv({ baseEnv: process.env, blockPathOverrides: true });
  if (options?.skillEnv) {
    Object.assign(
      env,
      sanitizeHostExecEnv({ baseEnv: {}, overrides: options.skillEnv, blockPathOverrides: true }),
    );
  }
  const preservedEnv = parseCliBackendPreserveEnv(process.env[CLI_BACKEND_PRESERVE_ENV]);
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
  return { env, selectedClaudeClearEnv };
}
