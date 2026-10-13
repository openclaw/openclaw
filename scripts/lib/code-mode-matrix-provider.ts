import { qaLiveFrontierProvider } from "../../extensions/qa-lab/test-api.js";
import { resolveProviderEnvAuthEvidence } from "../../src/agents/model-auth-env.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { getProviderEnvVarsCore } from "../../src/secrets/provider-env-vars.js";

export type MatrixProviderFailureCategory =
  | "provider_auth"
  | "provider_billing"
  | "provider_transport"
  | "model_unavailable";

export function classifyCodeModeMatrixProviderFailure(
  text: string,
): MatrixProviderFailureCategory | null {
  if (
    /\b402\b|billing|credits? (?:depleted|exhausted|insufficient)|payment required/iu.test(text)
  ) {
    return "provider_billing";
  }
  if (
    /model_not_found|unknown model|model[^\n]*(?:does not exist|not found|not available|not supported)|access to (?:this |the )?model/iu.test(
      text,
    )
  ) {
    return "model_unavailable";
  }
  if (
    /\b401\b|\b403\b|unauthorized|invalid (?:api[- ]?)?key|authentication_error|no api key|missing.*api.key/iu.test(
      text,
    )
  ) {
    return "provider_auth";
  }
  if (
    /connection refused|connect timeout|fetch failed|network|socket|stream.*(?:closed|ended)|http 5\d\d/iu.test(
      text,
    )
  ) {
    return "provider_transport";
  }
  return null;
}

export function matrixModelConfig(model: string, thinking: string): OpenClawConfig["agents"] {
  return {
    defaults: {
      model: { primary: model, fallbacks: [] },
      fastModeDefault: false,
      models: {
        [model]: {
          agentRuntime: { id: "openclaw" },
          params: {
            ...qaLiveFrontierProvider.resolveModelParams({ modelRef: model, fastMode: false }),
            fastMode: false,
            thinking,
          },
        },
      },
    },
  };
}

/** Copy only this provider's owner-declared credential inputs into the isolated run. */
export function matrixProviderEnv(
  model: string,
  config: OpenClawConfig,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const provider = model.slice(0, model.indexOf("/"));
  const names = getProviderEnvVarsCore(provider, {
    config,
    env: baseEnv,
    includeUntrustedWorkspacePlugins: false,
  });
  const supplied = names.filter((name) => baseEnv[name]?.trim());
  if (supplied.length > 1) {
    throw new Error(
      `Ambiguous benchmark authentication for ${provider}: supply exactly one of ${supplied.join(", ")}.`,
    );
  }
  const env: NodeJS.ProcessEnv = {};
  const name = supplied[0];
  if (name) {
    const evidence = resolveProviderEnvAuthEvidence(provider, baseEnv, {
      aliasMap: {},
      candidateMap: { [provider]: [name] },
      authEvidenceMap: {},
    });
    if (evidence?.mode !== "api-key") {
      throw new Error(
        `Benchmark ${provider} authentication requires an API-key environment input; ${name} has auth kind ${evidence?.mode ?? "unknown"}.`,
      );
    }
    env[name] = baseEnv[name];
  }
  if (provider === "ollama" && !env.OLLAMA_API_KEY) {
    env.OLLAMA_API_KEY = baseEnv.OLLAMA_API_KEY || "ollama-local";
  }
  return env;
}

export function matrixProviderAuthSelection(
  model: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  const provider = model.split("/")[0]!;
  const env = matrixProviderEnv(
    model,
    {
      plugins: { allow: [provider], entries: { [provider]: { enabled: true } } },
    },
    baseEnv,
  );
  const envName = Object.keys(env)[0] ?? null;
  return {
    provider,
    envName,
    authKind: envName ? (provider === "ollama" ? "local-marker" : "api-key") : "unavailable",
  };
}
