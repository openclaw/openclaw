import { randomUUID } from "node:crypto";
import {
  decisionBatchV1ToV2,
  decisionBatchV2ToV1,
  decodeSystemOneResponse,
  validateDecisionBatchV2,
  validateDecisionResultV2,
} from "openclaw/plugin-sdk/decisions";
import type {
  DecisionBatch,
  DecisionBatchV2,
  DecisionProviderV2,
  DecisionProviderContextV2,
} from "openclaw/plugin-sdk/decisions";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveProviderRequestHeaders } from "openclaw/plugin-sdk/provider-http";
import { omitNullRequestHeaders } from "openclaw/plugin-sdk/provider-request-headers";
import { resolveSecretInputString } from "openclaw/plugin-sdk/secret-input";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { hasCredentials, providerBaseUrl, type RuntimeConfig } from "./config.js";
import { decisionFailure } from "./errors.js";
import type { Evaluation, ImageAssets } from "./schema.js";

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

/** Preserve the text input bridge; only tagged image state adds separate assets. */
function translateBatch(
  batch: DecisionBatchV2,
): { batch: DecisionBatch; assets?: ImageAssets } | undefined {
  // Admit the full envelope before removing image bytes for the existing text translation.
  if (!validateDecisionBatchV2(batch)) {
    return undefined;
  }
  if (batch.state.type !== "image") {
    const text = decisionBatchV2ToV1(batch);
    return text ? { batch: text } : undefined;
  }
  const match = /^data:image\/(png|jpeg);base64,/.exec(batch.state.dataUri);
  if (
    !match ||
    Object.values(batch.questions).some(
      (question) =>
        question.type !== "boolean" && question.type !== "choice" && question.type !== "score",
    )
  ) {
    return undefined;
  }
  // TypeSafe replaces references inside strings; a UUID must not occur in caller text.
  const callerText = JSON.stringify([batch.state.text, batch.questions]);
  let ref = randomUUID();
  while (callerText.includes(ref)) {
    ref = randomUUID();
  }
  const translated = decisionBatchV2ToV1({
    state:
      batch.state.text === undefined
        ? { type: "text", text: ref }
        : { type: "json", value: [batch.state.text, ref] },
    questions: batch.questions,
  });
  if (!translated) {
    return undefined;
  }
  return {
    batch: translated,
    assets: {
      [ref]: {
        type: "image",
        format: match[1] === "png" ? "png" : "jpg",
        data_base64: batch.state.dataUri.slice(match[0].length),
      },
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
      normalizeTransport: () => {
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
      const request = translateBatch(batch);
      if (!request || (context.reasoning !== undefined && context.reasoning !== "auto")) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      const v1 = request.batch;
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
      const questions = Object.fromEntries(
        Object.entries(v1.questions).map(([id, q]) => [
          id,
          q.type === "boolean" ? { ...q, type: "noul" } : q,
        ]),
      );
      let evaluation: Evaluation;
      try {
        const response = await evaluateTypeSafe(
          { state: v1.state, questions, model },
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
      // Validate against the bounded text/UUID batch, not the separately admitted image bytes.
      const offered = decisionBatchV1ToV2(v1);
      if (!offered) {
        return { status: "unavailable", reason: "invalid-response" };
      }
      // Native metadata is not part of the decision accounting contract.
      const result = decodeSystemOneResponse(offered, {
        model: evaluation.model,
        answers: evaluation.answers,
        usage: {
          input_tokens: evaluation.usage.input_tokens,
          output_tokens: evaluation.usage.output_tokens,
        },
      });
      return validateDecisionResultV2(offered, result)
        ? { status: "ok", result }
        : { status: "unavailable", reason: "invalid-response" };
    },
  };
}
