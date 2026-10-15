import { sanitizeHostExecEnv } from "../../infra/host-env-security.js";
import { listKnownProviderEnvApiKeyNames } from "../model-auth-env-vars.js";
import {
  CLAUDE_SELECTED_AUTH_ENV_KEYS,
  CLI_BACKEND_PRESERVE_ENV,
  NODE_CLAUDE_FORWARD_ENV_KEYS,
  parseCliBackendPreserveEnv,
  resolveNodeClaudeAuthEnv,
} from "./execute-logging.js";
import type { PreparedCliRunContext } from "./types.js";

export function buildCliExecutionEnv(params: {
  context: PreparedCliRunContext;
  captureEnv?: Record<string, string>;
  installationEnv?: Readonly<Record<string, string>>;
}) {
  const { context } = params;
  const nativeAuthOnly = context.params.nativeAuthOnly;
  const backend = context.preparedBackend.backend;
  const nodePlacement = context.executionTarget.kind === "node";
  const nativeAuthEnvNames = new Set(
    nativeAuthOnly
      ? [
          ...listKnownProviderEnvApiKeyNames({
            config: context.params.config,
            workspaceDir: context.workspaceDir,
          }),
          ...CLAUDE_SELECTED_AUTH_ENV_KEYS,
          "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
        ].map((key) => key.toUpperCase())
      : [],
  );
  const preparedBackendEnv = context.preparedBackend.env ?? {};
  const hasSelectedClaudeAuth =
    Boolean(context.preparedBackend.secretInput) ||
    [...CLAUDE_SELECTED_AUTH_ENV_KEYS].some((key) => Object.hasOwn(preparedBackendEnv, key));
  // Native-login automations cannot restore host auth through backend overrides or live-test env.
  const backendClearEnv = new Set(
    (backend.clearEnv ?? []).map((key) => (nativeAuthOnly ? key.toUpperCase() : key)),
  );
  const authClearEnv = hasSelectedClaudeAuth || nativeAuthOnly ? backendClearEnv : undefined;
  const configuredBackendEnv = Object.fromEntries(
    Object.entries(backend.env ?? {}).filter(
      ([key]) => !authClearEnv?.has(nativeAuthOnly ? key.toUpperCase() : key),
    ),
  );
  const backendEnv = { ...configuredBackendEnv, ...preparedBackendEnv };
  const nodeEnvEntries = Object.entries(preparedBackendEnv).filter(([key]) =>
    NODE_CLAUDE_FORWARD_ENV_KEYS.has(key),
  );
  const nodeEnv = nodePlacement
    ? {
        ...Object.fromEntries(nodeEnvEntries),
        ...resolveNodeClaudeAuthEnv(context),
      }
    : undefined;
  const nodeRuntimeClearEnv = nodePlacement
    ? [...NODE_CLAUDE_FORWARD_ENV_KEYS].filter((key) => backend.clearEnv?.includes(key))
    : [];
  const nodeClearEnv = [
    ...new Set([...(authClearEnv ?? []), ...nodeRuntimeClearEnv, ...nativeAuthEnvNames]),
  ];
  const env = sanitizeHostExecEnv({ baseEnv: process.env, blockPathOverrides: true });
  const preservedEnv = parseCliBackendPreserveEnv(process.env[CLI_BACKEND_PRESERVE_ENV]);
  for (const key of Object.keys(env)) {
    const clearKey = nativeAuthOnly ? key.toUpperCase() : key;
    if (backendClearEnv.has(clearKey) && (!preservedEnv.has(key) || authClearEnv?.has(clearKey))) {
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
  Object.assign(env, params.captureEnv, params.installationEnv);
  if (nativeAuthOnly) {
    for (const key of Object.keys(env)) {
      if (nativeAuthEnvNames.has(key.toUpperCase())) {
        delete env[key];
      }
    }
  }
  // Never mark Claude CLI as host-managed. That marker routes runs into
  // Anthropic's separate host-managed usage tier instead of normal CLI use.
  delete env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST;
  return { env, nodeEnv, nodeClearEnv };
}
