import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { withTrustedEnvProxyGuardedFetchMode } from "openclaw/plugin-sdk/fetch-runtime";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderResolveDynamicModelContext,
  ProviderThinkingProfile,
  AnyAgentTool,
  ProviderNormalizeToolSchemasContext,
  ProviderToolSchemaDiagnostic,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildProviderToolCompatFamilyHooks,
  findUnsupportedSchemaKeywords,
  SCHEMA_MAP_KEYS,
  SCHEMA_NESTED_KEYS,
} from "openclaw/plugin-sdk/provider-tools";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { asOptionalRecord as readRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { containsAsciiControlCharacter } from "openclaw/plugin-sdk/string-normalization-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { parseClawRouterPool, type ClawRouterPoolResult } from "./pool.js";
import {
  buildClawRouterProviderConfig,
  CLAWROUTER_REASONING_EFFORT_LEVELS,
  normalizeClawRouterApiBaseUrl,
  normalizeClawRouterReasoningEfforts,
  normalizeClawRouterRootUrl,
  normalizeClawRouterResolvedModel,
  prepareClawRouterRequestModel,
} from "./provider-catalog.js";
import { fetchClawRouterUsage } from "./usage.js";

const PERPLEXITY_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "patternProperties",
  "additionalProperties",
]);

const ENV_API_KEY_MARKER = "CLAWROUTER_API_KEY";
const ATTRIBUTION_VALUE_MAX_LENGTH = 256;
const REQUEST_ID_MAX_LENGTH = 128;
const CLIENT_HEADER = "X-ClawRouter-Client";
const AGENT_HEADER = "X-ClawRouter-Agent-Id";
const SESSION_HEADER = "X-ClawRouter-Session-Id";
const REQUEST_ID_HEADER = "X-Request-ID";
const ID_HASH_LENGTH = 16;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._~:/+@=-]+$/u;
const REQUEST_ID_UNSAFE_CHARACTER_PATTERN = /[^A-Za-z0-9._~:/+@=-]/gu;
const ATTRIBUTION_PRINTABLE_ASCII_PATTERN = /^[\x20-\x7E]+$/u;
const ATTRIBUTION_NON_PRINTABLE_ASCII_PATTERN = /[^\x20-\x7E]/gu;
const ATTRIBUTION_ENCODED_SUFFIX_PATTERN = /~[a-f0-9]{16}$/u;
const REQUEST_ID_SUFFIX_PATTERN = /:model:\d+$/u;
const REQUEST_ID_ENCODED_SUFFIX_PATTERN = /~[a-f0-9]{16}(?::model:\d+)?$/u;

type BoundedIdPolicy = {
  encodedSuffixPattern: RegExp;
  maxLength: number;
  safePattern: RegExp;
  unsafeCharacterPattern: RegExp;
  preservedSuffixPattern?: RegExp;
};

const ATTRIBUTION_ID_POLICY: BoundedIdPolicy = {
  encodedSuffixPattern: ATTRIBUTION_ENCODED_SUFFIX_PATTERN,
  maxLength: ATTRIBUTION_VALUE_MAX_LENGTH,
  safePattern: ATTRIBUTION_PRINTABLE_ASCII_PATTERN,
  unsafeCharacterPattern: ATTRIBUTION_NON_PRINTABLE_ASCII_PATTERN,
};
const REQUEST_ID_POLICY: BoundedIdPolicy = {
  encodedSuffixPattern: REQUEST_ID_ENCODED_SUFFIX_PATTERN,
  maxLength: REQUEST_ID_MAX_LENGTH,
  safePattern: REQUEST_ID_PATTERN,
  unsafeCharacterPattern: REQUEST_ID_UNSAFE_CHARACTER_PATTERN,
  preservedSuffixPattern: REQUEST_ID_SUFFIX_PATTERN,
};

function normalizeHeaderId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || containsAsciiControlCharacter(normalized)) {
    return undefined;
  }
  return normalized;
}

function sanitizeBoundedId(value: string | undefined, policy: BoundedIdPolicy): string | undefined {
  const normalized = normalizeHeaderId(value);
  if (!normalized) {
    return undefined;
  }
  if (
    normalized.length <= policy.maxLength &&
    policy.safePattern.test(normalized) &&
    !policy.encodedSuffixPattern.test(normalized)
  ) {
    return normalized;
  }
  // Hash UTF-16 code units losslessly: UTF-8 string hashing replaces lone
  // surrogates with U+FFFD. The reserved encoded suffix keeps a rewritten ID
  // from aliasing an otherwise safe input that already looks encoded.
  const hash = createHash("sha256")
    .update(Buffer.from(normalized, "utf16le"))
    .digest("hex")
    .slice(0, ID_HASH_LENGTH);
  const preservedSuffix = policy.preservedSuffixPattern?.exec(normalized)?.[0] ?? "";
  const rawPrefix = preservedSuffix ? normalized.slice(0, -preservedSuffix.length) : normalized;
  const safePrefix = rawPrefix.replace(policy.unsafeCharacterPattern, "_");
  const hashSuffix = `~${hash}`;
  const boundedSuffix = `${hashSuffix}${preservedSuffix}`;
  const suffix = boundedSuffix.length < policy.maxLength ? boundedSuffix : hashSuffix;
  return `${safePrefix.slice(0, policy.maxLength - suffix.length)}${suffix}`;
}

function findHeader(headers: Record<string, string>, target: string): string | undefined {
  const normalizedTarget = target.toLowerCase();
  return Object.entries(headers).find(([name]) => name.toLowerCase() === normalizedTarget)?.[1];
}

function setHeaderDefault(
  headers: Record<string, string>,
  name: string,
  value: string | undefined,
): void {
  if (value !== undefined && findHeader(headers, name) === undefined) {
    headers[name] = value;
  }
}

function wrapClawRouterProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  const underlying = ctx.streamFn;
  if (!underlying) {
    return undefined;
  }
  return (model, context, options) => {
    const apiKey = options?.apiKey?.trim();
    const dispatchKey = apiKey && apiKey !== ENV_API_KEY_MARKER ? apiKey : undefined;
    const preparedModel = prepareClawRouterRequestModel(model);
    const hasExplicitRequestId =
      findHeader(options?.headers ?? {}, REQUEST_ID_HEADER) !== undefined;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(preparedModel.headers ?? {})) {
      if (name.toLowerCase() !== "authorization" || !dispatchKey) {
        headers[name] = value;
      }
    }
    setHeaderDefault(headers, CLIENT_HEADER, "openclaw");
    setHeaderDefault(headers, AGENT_HEADER, sanitizeBoundedId(ctx.agentId, ATTRIBUTION_ID_POLICY));
    setHeaderDefault(
      headers,
      SESSION_HEADER,
      sanitizeBoundedId(options?.sessionId, ATTRIBUTION_ID_POLICY),
    );
    setHeaderDefault(
      headers,
      REQUEST_ID_HEADER,
      sanitizeBoundedId(hasExplicitRequestId ? undefined : options?.requestId, REQUEST_ID_POLICY),
    );
    if (dispatchKey) {
      headers.Authorization = `Bearer ${dispatchKey}`;
    }
    return underlying({ ...preparedModel, headers }, context, options);
  };
}

// JSON Schema allows `type` to be an array; a union containing "object" still
// admits objects, so it needs `properties` for Perplexity too.
function isObjectType(type: unknown): boolean {
  return type === "object" || (Array.isArray(type) && type.includes("object"));
}

function normalizeSchemaMap(value: unknown): unknown {
  const record = readRecord(value);
  if (!record) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, schema]) => [key, normalizePerplexitySchema(schema)]),
  );
}

function normalizePerplexitySchema(value: object): object;
function normalizePerplexitySchema(value: unknown): unknown;
function normalizePerplexitySchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizePerplexitySchema);
  }
  const record = readRecord(value);
  if (!record) {
    return value;
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (PERPLEXITY_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      continue;
    }
    normalized[key] = SCHEMA_MAP_KEYS.has(key)
      ? normalizeSchemaMap(child)
      : SCHEMA_NESTED_KEYS.has(key)
        ? normalizePerplexitySchema(child)
        : child;
  }
  if (isObjectType(normalized.type) && !("properties" in normalized)) {
    normalized.properties = {};
  }
  return normalized;
}

function findObjectSchemasMissingProperties(schema: unknown, path: string): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((child, index) =>
      findObjectSchemasMissingProperties(child, `${path}[${index}]`),
    );
  }
  const record = readRecord(schema);
  if (!record) {
    return [];
  }
  const violations =
    isObjectType(record.type) && !("properties" in record) ? [`${path}.properties`] : [];
  for (const [key, child] of Object.entries(record)) {
    if (PERPLEXITY_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      continue;
    }
    if (SCHEMA_MAP_KEYS.has(key)) {
      const schemas = readRecord(child);
      if (schemas) {
        for (const [name, nestedSchema] of Object.entries(schemas)) {
          violations.push(
            ...findObjectSchemasMissingProperties(nestedSchema, `${path}.${key}.${name}`),
          );
        }
      }
      continue;
    }
    if (SCHEMA_NESTED_KEYS.has(key)) {
      violations.push(...findObjectSchemasMissingProperties(child, `${path}.${key}`));
    }
  }
  return violations;
}

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1024 * 1024;
const unavailable = (): ClawRouterPoolResult => ({
  status: "unavailable",
  message:
    "ClawRouter pool status is unavailable. Check the ClawRouter connection and try Refresh.",
});

async function readJson(response: Response): Promise<unknown> {
  const bytes = await readResponseWithLimit(response, MAX_BYTES, { chunkTimeoutMs: TIMEOUT_MS });
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

const PROVIDER_ID = "clawrouter";
const ENV_VAR = "CLAWROUTER_API_KEY";

const openAiReplay = buildProviderReplayFamilyHooks({
  family: "openai-compatible",
  dropReasoningFromHistory: false,
});
const anthropicReplay = buildProviderReplayFamilyHooks({
  family: "native-anthropic-by-model",
});
const googleReplay = buildProviderReplayFamilyHooks({ family: "google-gemini" });
const openAiTools = buildProviderToolCompatFamilyHooks("openai");
const deepSeekTools = buildProviderToolCompatFamilyHooks("deepseek");
const geminiTools = buildProviderToolCompatFamilyHooks("gemini");
const perplexityTools = {
  normalizeToolSchemas(ctx: ProviderNormalizeToolSchemasContext): AnyAgentTool[] {
    return ctx.tools.map((tool) => {
      if (!tool.parameters || typeof tool.parameters !== "object") {
        return tool;
      }
      return {
        ...tool,
        parameters: normalizePerplexitySchema(tool.parameters),
      };
    });
  },
  inspectToolSchemas(ctx: ProviderNormalizeToolSchemasContext): ProviderToolSchemaDiagnostic[] {
    return ctx.tools.flatMap((tool, toolIndex) => {
      const path = `${tool.name}.parameters`;
      const violations = [
        ...findUnsupportedSchemaKeywords(
          tool.parameters,
          path,
          PERPLEXITY_UNSUPPORTED_SCHEMA_KEYWORDS,
        ),
        ...findObjectSchemasMissingProperties(tool.parameters, path),
      ];
      return violations.length > 0 ? [{ toolName: tool.name, toolIndex, violations }] : [];
    });
  },
};

function resolveClawRouterThinkingProfile(
  ctx: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile | undefined {
  const efforts = normalizeClawRouterReasoningEfforts(ctx.compat?.supportedReasoningEfforts);
  if (!efforts) {
    return undefined;
  }
  const supported = new Set(efforts);
  const levels: Array<ProviderThinkingProfile["levels"][number]> =
    CLAWROUTER_REASONING_EFFORT_LEVELS.filter(([effort]) => supported.has(effort)).map(
      ([, id]) => ({ id }),
    );
  const runtime = ctx.agentRuntime?.trim().toLowerCase();
  if (
    levels.some((level) => level.id === "max") &&
    (runtime === "openclaw" || runtime === "auto")
  ) {
    levels.push({ id: "ultra" });
  }
  return { levels };
}

function configuredBaseUrl(
  config: ProviderResolveDynamicModelContext["config"],
): string | undefined {
  return config?.models?.providers?.[PROVIDER_ID]?.baseUrl;
}

function resolveToolFamily(modelId: string) {
  const normalized = modelId.toLowerCase();
  if (normalized.startsWith("deepseek/")) {
    return deepSeekTools;
  }
  if (normalized.startsWith("google/")) {
    return geminiTools;
  }
  if (normalized.startsWith("perplexity/")) {
    return perplexityTools;
  }
  return openAiTools;
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "ClawRouter",
  description: "Managed multi-provider model routing and quotas",
  manifest,
  register(api) {
    api.registerGatewayMethod(
      "clawrouter.pool.get",
      async (request) => {
        const config = request.context.getRuntimeConfig();
        const signal = request.signal;
        const current = () => {
          signal?.throwIfAborted();
          request.client?.connectionSignal?.throwIfAborted();
          if (request.hasCurrentClientAuthority?.() === false) {
            throw new Error("Retired pool request");
          }
        };
        let result: ClawRouterPoolResult;
        try {
          current();
          const { resolveApiKeyForProvider } =
            await import("openclaw/plugin-sdk/provider-auth-runtime");
          let token: string | undefined;
          try {
            token = (
              await resolveApiKeyForProvider({
                provider: "clawrouter",
                cfg: config,
                signal,
              })
            )?.apiKey;
          } catch {
            // Auth diagnostics can include credential details; only return fixed next steps.
          }
          current();
          if (!token) {
            result = {
              status: "not_configured",
              message: "Configure a ClawRouter key in Model Providers, then try Refresh.",
            };
          } else {
            const baseUrl = normalizeClawRouterRootUrl(
              config.models?.providers?.clawrouter?.baseUrl,
            );
            const { response, release } = await fetchWithSsrFGuard(
              withTrustedEnvProxyGuardedFetchMode({
                url: `${baseUrl}/v1/pool`,
                init: { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } },
                timeoutMs: TIMEOUT_MS,
                signal,
                policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
                auditContext: "clawrouter.pool",
              }),
            );
            try {
              if (response.status === 401 || response.status === 403) {
                result = {
                  status: "unauthorized",
                  message:
                    "The ClawRouter key was rejected. Check or replace it in Model Providers.",
                };
              } else if (response.status === 404) {
                const body = readRecord(await readJson(response).catch(() => undefined));
                const error = readRecord(body?.error);
                result =
                  body?.code === "pool_status_hidden" ||
                  error?.code === "pool_status_hidden" ||
                  body?.error === "pool_status_hidden"
                    ? {
                        status: "hidden",
                        message: "Ask your ClawRouter admin to enable pool status for this policy.",
                      }
                    : {
                        status: "unsupported",
                        message:
                          "This ClawRouter deployment does not expose pool status. Ask your admin to update ClawRouter.",
                      };
              } else if (response.status === 405) {
                result = {
                  status: "unsupported",
                  message:
                    "This ClawRouter deployment does not expose pool status. Ask your admin to update ClawRouter.",
                };
              } else if (!response.ok) {
                result = unavailable();
              } else {
                const pool = parseClawRouterPool(await readJson(response));
                result = pool ? { status: "ok", pool } : unavailable();
              }
            } finally {
              void response.body?.cancel().catch(() => undefined);
              await release();
            }
          }
          current();
        } catch {
          result = unavailable();
        }
        request.respond(true, result);
      },
      { scope: "operator.read" },
    );
  },
  provider() {
    return {
      label: "ClawRouter",
      docsPath: "/providers/clawrouter",
      manifestAuth: {
        hint: "Credential-scoped access to approved models and budgets",
        noteTitle: "ClawRouter",
        noteMessage: [
          "Use the proxy key issued by your ClawRouter administrator.",
          "OpenClaw discovers only the models granted to that key.",
        ].join("\n"),
      },
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const auth = ctx.resolveProviderAuth(PROVIDER_ID);
          let discoveryApiKey = auth.discoveryApiKey;
          if (!discoveryApiKey) {
            try {
              const { resolveApiKeyForProvider } =
                await import("openclaw/plugin-sdk/provider-auth-runtime");
              discoveryApiKey = (
                await resolveApiKeyForProvider({
                  provider: PROVIDER_ID,
                  cfg: ctx.config,
                  ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
                  ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
                  ...(auth.profileId ? { profileId: auth.profileId, lockedProfile: true } : {}),
                })
              )?.apiKey;
            } catch {
              return null;
            }
          }
          const apiKey = auth.apiKey ?? discoveryApiKey;
          if (!apiKey || !discoveryApiKey) {
            return null;
          }
          return {
            provider: await buildClawRouterProviderConfig({
              apiKey,
              discoveryApiKey,
              baseUrl: configuredBaseUrl(ctx.config),
            }),
          };
        },
      },
      // Live catalog routing also applies to explicitly configured model rows.
      preferRuntimeResolvedModel: () => true,
      prepareDynamicModel: async (ctx) => {
        const { resolveApiKeyForProvider } =
          await import("openclaw/plugin-sdk/provider-auth-runtime");
        const apiKey = (
          await resolveApiKeyForProvider({
            provider: PROVIDER_ID,
            cfg: ctx.config,
            ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
            ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
            ...(ctx.authProfileId ? { profileId: ctx.authProfileId, lockedProfile: true } : {}),
          })
        )?.apiKey;
        if (!apiKey) {
          return undefined;
        }
        const providerConfig = await buildClawRouterProviderConfig({
          apiKey,
          discoveryApiKey: apiKey,
          baseUrl: ctx.providerConfig?.baseUrl ?? configuredBaseUrl(ctx.config),
        });
        const model = providerConfig.models.find((entry) => entry.id === ctx.modelId);
        if (!model) {
          return undefined;
        }
        return {
          ...model,
          api: model.api ?? providerConfig.api,
          baseUrl: model.baseUrl ?? providerConfig.baseUrl,
          provider: PROVIDER_ID,
          input: model.input.filter(
            (entry): entry is "text" | "image" => entry === "text" || entry === "image",
          ),
        };
      },
      normalizeConfig: ({ providerConfig }) => {
        const baseUrl = normalizeClawRouterApiBaseUrl(providerConfig.baseUrl);
        return baseUrl !== providerConfig.baseUrl ? { ...providerConfig, baseUrl } : undefined;
      },
      normalizeResolvedModel: ({ model }) => normalizeClawRouterResolvedModel(model),
      wrapSimpleCompletionStreamFn: wrapClawRouterProviderStream,
      wrapStreamFn: wrapClawRouterProviderStream,
      buildReplayPolicy: (ctx) => {
        if (ctx.modelApi === "anthropic-messages") {
          return anthropicReplay.buildReplayPolicy?.(ctx);
        }
        if (ctx.modelApi === "google-generative-ai") {
          return googleReplay.buildReplayPolicy?.(ctx);
        }
        return openAiReplay.buildReplayPolicy?.(ctx);
      },
      sanitizeReplayHistoryAsync: (ctx) =>
        ctx.modelApi === "google-generative-ai"
          ? googleReplay.sanitizeReplayHistoryAsync?.(ctx)
          : undefined,
      resolveReasoningOutputMode: (ctx) =>
        ctx.modelApi === "google-generative-ai"
          ? googleReplay.resolveReasoningOutputMode?.(ctx)
          : undefined,
      resolveThinkingProfile: resolveClawRouterThinkingProfile,
      normalizeToolSchemas: (ctx) => resolveToolFamily(ctx.modelId ?? "").normalizeToolSchemas(ctx),
      inspectToolSchemas: (ctx) => resolveToolFamily(ctx.modelId ?? "").inspectToolSchemas(ctx),
      isModernModelRef: () => true,
      resolveUsageAuth: async (ctx) => {
        const apiKey = (
          await ctx.resolveApiKeyCandidatesFromConfigAndStore?.({
            envDirect: [ctx.env[ENV_VAR]],
          })
        )?.[0];
        return apiKey ? { token: apiKey } : null;
      },
      fetchUsageSnapshot: async (ctx) =>
        await fetchClawRouterUsage({
          token: ctx.token,
          baseUrl: configuredBaseUrl(ctx.config),
          timeoutMs: ctx.timeoutMs,
          signal: ctx.signal,
        }),
    };
  },
});
