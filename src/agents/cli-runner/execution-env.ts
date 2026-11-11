import { sanitizeHostExecEnv } from "../../infra/host-env-security.js";
import {
  listKnownProviderAuthEnvVarNamesCore,
  type ProviderEnvVarLookupParams,
} from "../../secrets/provider-env-vars.js";
import {
  CLAUDE_SELECTED_AUTH_ENV_KEYS,
  CLI_BACKEND_PRESERVE_ENV,
  NODE_CLAUDE_FORWARD_ENV_KEYS,
  parseCliBackendPreserveEnv,
} from "./execute-logging.js";
import type { PreparedCliRunContext } from "./types.js";

type ChildEnvBackend = Pick<
  PreparedCliRunContext["preparedBackend"],
  "backend" | "env" | "resetEnv" | "secretInput"
>;

// These exclusions reset ambient defaults before the backend applies the turn's settings.
const CLI_RUNTIME_ENV_KEYS = new Set([
  ...NODE_CLAUDE_FORWARD_ENV_KEYS,
  "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING",
  "MAX_THINKING_TOKENS",
]);

/** Apply native-login policy after all overlays, using this execution host's inventory. */
export function stripCliNativeAuthEnv(
  env: Record<string, string>,
  params: Pick<ProviderEnvVarLookupParams, "config" | "workspaceDir">,
  clearEnv: Iterable<string> = [],
): void {
  const denied = new Set(
    [
      ...Array.from(clearEnv).filter((key) => !CLI_RUNTIME_ENV_KEYS.has(key.toUpperCase())),
      ...listKnownProviderAuthEnvVarNamesCore(params),
      ...CLAUDE_SELECTED_AUTH_ENV_KEYS,
      "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
      "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    ].map((key) => key.toUpperCase()),
  );
  for (const key of Object.keys(env)) {
    if (denied.has(key.toUpperCase())) {
      delete env[key];
    }
  }
}

/**
 * The environment a local CLI child starts from: the Gateway process, minus the backend's
 * clearEnv, plus backend and prepared overrides. Preparation and execution both call this,
 * so what a history owner is derived from is the environment the child actually receives.
 * Per-attempt MCP capture and installation variables are overlaid before native auth is stripped.
 */
export function resolveCliChildEnv(
  preparedBackend: ChildEnvBackend,
  params: Pick<ProviderEnvVarLookupParams, "config" | "workspaceDir"> & {
    nativeAuthOnly?: true;
  } = {},
  overrides?: Record<string, string>,
): {
  env: Record<string, string>;
  selectedClaudeClearEnv: Set<string> | undefined;
} {
  const { backend } = preparedBackend;
  const clearEnv = [...(backend.clearEnv ?? []), ...(preparedBackend.resetEnv ?? [])];
  const preparedBackendEnv = preparedBackend.env ?? {};
  const hasSelectedClaudeAuth =
    !params.nativeAuthOnly &&
    (Boolean(preparedBackend.secretInput) ||
      [...CLAUDE_SELECTED_AUTH_ENV_KEYS].some((key) => Object.hasOwn(preparedBackendEnv, key)));
  const selectedClaudeClearEnv = hasSelectedClaudeAuth ? new Set(clearEnv) : undefined;
  const configuredBackendEnv = Object.fromEntries(
    Object.entries(backend.env ?? {}).filter(([key]) => !selectedClaudeClearEnv?.has(key)),
  );
  const backendEnv = { ...configuredBackendEnv, ...preparedBackendEnv };
  const env = sanitizeHostExecEnv({ baseEnv: process.env, blockPathOverrides: true });
  const preservedEnv = parseCliBackendPreserveEnv(process.env[CLI_BACKEND_PRESERVE_ENV]);
  for (const key of clearEnv) {
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
  Object.assign(env, overrides);
  if (params.nativeAuthOnly) {
    stripCliNativeAuthEnv(env, params, backend.clearEnv);
  }
  // Claude's native login must never enter the separate host-managed usage tier.
  delete env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST;
  return { env, selectedClaudeClearEnv };
}
