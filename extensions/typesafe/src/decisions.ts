import { encodeSystemOneQuestions } from "openclaw/plugin-sdk/decisions";
import type { DecisionProviderV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveProviderRequestHeaders } from "openclaw/plugin-sdk/provider-http";
import { omitNullRequestHeaders } from "openclaw/plugin-sdk/provider-request-headers";
import { resolveSecretInputString } from "openclaw/plugin-sdk/secret-input";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { hasCredentials, providerBaseUrl, type RuntimeConfig } from "./config.js";
import { decodeTypeSafeDecisionResult, translateTypeSafeDecisionBatch } from "./decision-codec.js";
import { decisionFailure } from "./errors.js";
import type { Evaluation } from "./schema.js";

const loadClient = createLazyRuntimeModule(() => import("./client.js"));
const models = manifest.modelCatalog.providers.typesafe.models;
const hostedBaseUrl = providerBaseUrl(models[0]!.baseUrl);
type Inference = NonNullable<DecisionProviderContextV2["model"]["inference"]>;

function effectiveBaseUrl(config: RuntimeConfig): string {
  return config.providerConfig
    ? providerBaseUrl(config.providerConfig.baseUrl)
    : config.baseUrl
      ? `${config.baseUrl}/v1`
      : hostedBaseUrl;
}

function bindHostedFacts(inference: Inference, id: string, config: RuntimeConfig): Inference {
  const declared = models.find((model) => model.id === id)?.inference.decision;
  if (!declared || !inference.decision) {
    return inference;
  }
  const configured = config.providerConfig;
  const configuredModel = configured?.models.find((model) => model.id === id);
  const headers = (values: Record<string, unknown> | undefined) =>
    Object.fromEntries(
      Object.entries(values ?? {}).flatMap(([name, value]) => {
        if (name.trim().toLowerCase() !== "typesafe-danger-zone-long-context") {
          return [];
        }
        const resolved = resolveSecretInputString({
          value,
          path: `models.providers.typesafe.headers.${name}`,
          mode: "inspect",
        });
        // Inspect only; unresolved configuration cannot establish default context limits.
        const header =
          resolved.status === "configured_unavailable" ? "unavailable" : resolved.value;
        return header === undefined ? [] : [[name, header]];
      }),
    );
  // Catalog rows omit transport headers. Read the same authored precedence as the
  // prepared request before any hosted limits or billing reach the accounting handoff.
  const mergedHeaders = resolveProviderRequestHeaders({
    provider: "typesafe",
    baseUrl: effectiveBaseUrl(config),
    defaultHeaders: headers(configured?.headers),
    callerHeaders: headers(configuredModel?.headers),
    precedence: "caller-wins",
  });
  const effectiveHeaders = resolveProviderRequestHeaders({
    provider: "typesafe",
    baseUrl: effectiveBaseUrl(config),
    defaultHeaders: mergedHeaders,
    request: {
      headers: headers(configured?.request?.headers),
      ...(configured?.request?.auth?.mode === "header" &&
      configured.request.auth.headerName.trim().toLowerCase() ===
        "typesafe-danger-zone-long-context"
        ? {
            auth: {
              ...configured.request.auth,
              value:
                resolveSecretInputString({
                  value: configured.request.auth.value,
                  path: "models.providers.typesafe.request.auth.value",
                  mode: "inspect",
                }).value ?? "unavailable",
            },
          }
        : {}),
    },
  });
  const hosted = effectiveBaseUrl(config) === hostedBaseUrl;
  const contextHeader = new Headers(omitNullRequestHeaders(effectiveHeaders)).get(
    "TypeSafe-Danger-Zone-Long-Context",
  );
  if (hosted && contextHeader !== "true" && contextHeader !== "unavailable") {
    return inference;
  }
  // These token limits describe hosted execution; configured models expose no native overrides.
  const { billing, limits, ...decision } = inference.decision;
  const {
    maxRequestTokens: _maxRequestTokens,
    maxStateAndQuestionTokens: _maxStateAndQuestionTokens,
    image,
    ...otherLimits
  } = limits ?? {};
  return {
    ...inference,
    decision: {
      ...decision,
      ...(!hosted ? { input: decision.input.filter((kind) => kind !== "image") } : {}),
      ...(billing && (hosted || billing.source !== "provider-docs") ? { billing } : {}),
      ...(Object.keys(otherLimits).length || (hosted && image)
        ? { limits: { ...otherLimits, ...(hosted && image ? { image } : {}) } }
        : {}),
    },
  };
}

/** The shared provider owns the same credential and full configured route as V1. */
export function createPreparedDecisionProvider(getConfig: () => RuntimeConfig): DecisionProviderV2 {
  const common = models[0]!.inference.decision;
  const inference: Inference = {
    chat: false,
    decision: {
      protocol: "typesafe-systemone",
      input: ["text"],
      questions: {
        boolean: { probabilities: "boolean", abstention: false },
        choice: {
          probabilities: "provider-defined",
          abstention: false,
          minOptions: common.questions.choice.minOptions,
          maxOptions: common.questions.choice.maxOptions,
        },
        score: {
          probabilities: "provider-defined",
          abstention: false,
          minOptions: common.questions.score.minOptions,
          maxOptions: common.questions.score.maxOptions,
        },
      },
      confidence: "provider-specific",
      reasoning: { modes: ["auto"] },
    },
  };
  return {
    id: "typesafe",
    contractVersion: 2,
    provider: {
      label: "TypeSafe AI",
      auth: [],
      authScope: "plugin",
      resolveSyntheticAuth: () => {
        const config = getConfig();
        if (!hasCredentials(config)) {
          return undefined;
        }
        // The marker is local no-auth evidence. The transport never sends it as a bearer credential.
        return {
          apiKey: config.apiKey || "typesafe-local",
          source: "typesafe plugin",
          mode: "api-key",
        };
      },
      normalizeTransport: ({ provider }) => {
        if (provider !== "typesafe") {
          return undefined;
        }
        return { baseUrl: effectiveBaseUrl(getConfig()) };
      },
      augmentModelCatalog: ({ entries }) =>
        entries
          .filter((entry) => entry.provider === "typesafe")
          .map((entry) =>
            Object.assign({}, entry, {
              // Canonical declarations own route-bound facts; only V1 inputs need protocol enrichment.
              inference: bindHostedFacts(
                entry.inference?.decision && entry.inference.decision.protocol !== "decision-v1"
                  ? entry.inference
                  : inference,
                entry.id,
                getConfig(),
              ),
            }),
          ),
    },
    async evaluate(batch, context) {
      const request = translateTypeSafeDecisionBatch(batch);
      if (!request || (context.reasoning !== undefined && context.reasoning !== "auto")) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      const nativeBatch = request.batch;
      if (
        request.assets &&
        !models.some(
          (model) =>
            model.id === context.model.id && model.inference.decision.input.includes("image"),
        )
      ) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      const original = getConfig();
      const providerConfig = original.providerConfig
        ? {
            ...original.providerConfig,
            baseUrl: context.model.baseUrl ?? original.providerConfig.baseUrl,
            headers:
              omitNullRequestHeaders(context.model.headers) ?? original.providerConfig.headers,
          }
        : undefined;
      const prepared: RuntimeConfig = {
        ...original,
        providerConfig,
        apiKey:
          original.baseUrl && !providerConfig
            ? undefined
            : context.auth.apiKey === "typesafe-local"
              ? undefined
              : context.auth.apiKey,
      };
      const readPreparedConfig = () => {
        const current = getConfig();
        // Reuse the exact prepared object only while the underlying config owner remains unchanged.
        return current.baseUrl === original.baseUrl &&
          current.providerConfig === original.providerConfig &&
          current.apiKey === original.apiKey &&
          current.credentialsUnavailable === original.credentialsUnavailable
          ? prepared
          : { ...current, credentialsUnavailable: true };
      };
      const model = context.model.id;
      const { signal, deadlineMonotonicMs, isAdmissible } = context;
      signal.throwIfAborted();
      // Registration and readiness do not need the transport or compiled validators.
      // Sample configuration and the remaining deadline after the cold import settles.
      const { evaluate: evaluateTypeSafe } = await loadClient();
      signal.throwIfAborted();
      const config = readPreparedConfig();
      if (!hasCredentials(config)) {
        return { status: "unavailable", reason: "credentials-unavailable" };
      }
      const remaining = deadlineMonotonicMs - performance.now();
      if (remaining <= 0) {
        return { status: "unavailable", reason: "transport" };
      }
      const questions = encodeSystemOneQuestions(nativeBatch);
      let evaluation: Evaluation;
      try {
        const response = await evaluateTypeSafe(
          {
            state:
              nativeBatch.state.type === "text" ? nativeBatch.state.text : nativeBatch.state.value,
            questions,
            model,
          },
          { ...config, timeoutMs: Math.min(config.timeoutMs, remaining) },
          signal,
          deadlineMonotonicMs,
          () => {
            if (!isAdmissible()) {
              return false;
            }
            // DNS and capture admission may await; only the current owner may authorize egress.
            const current = readPreparedConfig();
            return (
              current.baseUrl === config.baseUrl &&
              current.providerConfig === config.providerConfig &&
              current.apiKey === config.apiKey &&
              !current.credentialsUnavailable
            );
          },
          request.assets,
        );
        signal.throwIfAborted();
        evaluation = response.evaluation;
      } catch (error) {
        signal.throwIfAborted();
        return decisionFailure(error);
      }
      const result = decodeTypeSafeDecisionResult(nativeBatch, evaluation);
      return result
        ? { status: "ok", result }
        : { status: "unavailable", reason: "invalid-response" };
    },
  };
}
