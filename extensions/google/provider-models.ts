import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveMergedModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import { resolveFamilyForwardCompatModel } from "openclaw/plugin-sdk/provider-model-shared";
import {
  normalizeOptionalLowercaseString,
  normalizeUniqueTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeGoogleModelId, stripGoogleProviderPrefix } from "./model-id.js";
import { isOfficialGoogleAiStudioBaseUrl } from "./src/google-api-base-url.js";

const GOOGLE_GEMINI_CLI_PROVIDER_ID = "google-gemini-cli";
const GOOGLE_ANTIGRAVITY_PROVIDER_ID = "google-antigravity";
const GEMINI_3_PRO_RE = /^gemini-3(?:\.\d+)?-pro(?:-|$)/;
const GEMINI_3_FLASH_LITE_RE = /^gemini-3(?:\.\d+)?-flash-lite(?:-|$)/;
const GEMINI_3_FLASH_RE = /^gemini-3(?:\.\d+)?-flash(?:-|$)/;
const GEMINI_4_RE = /^gemini-4(?:[.-]|$)/;
const GEMINI_PRO_LATEST_ID = "gemini-pro-latest";
const GEMINI_FLASH_LATEST_ID = "gemini-flash-latest";
const GEMINI_FLASH_LITE_LATEST_ID = "gemini-flash-lite-latest";
const GEMMA_PREFIX = "gemma-";
const GEMINI_3_1_PRO_TEMPLATE_IDS = ["gemini-3.1-pro-preview", "gemini-3-pro-preview"] as const;
const GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS = ["gemini-3.1-flash-lite"] as const;
const GEMINI_3_1_FLASH_TEMPLATE_IDS = ["gemini-3-flash-preview", "gemini-2.5-flash"] as const;
const GEMINI_3_FLASH_ANTIGRAVITY_TEMPLATE_IDS = ["gemini-3-flash"] as const;
const GEMINI_4_TEMPLATE_IDS = ["gemini-4-argon"] as const;
const GOOGLE_PROVIDER_PREFIX = "google/";
const GOOGLE_NON_TEXT_MODEL_ID_MARKERS = [
  "-image",
  "-tts",
  "-live",
  "-embedding",
  "native-audio",
] as const;

function normalizeGeminiProRequestId(id: string): string {
  if (id.startsWith(GOOGLE_PROVIDER_PREFIX)) {
    const modelId = id.slice(GOOGLE_PROVIDER_PREFIX.length);
    const normalizedModelId = normalizeGeminiProRequestId(modelId);
    return normalizedModelId === modelId ? id : `${GOOGLE_PROVIDER_PREFIX}${normalizedModelId}`;
  }
  if (id === "gemini-3-pro" || id === "gemini-3-pro-preview" || id === "gemini-3.1-pro") {
    return "gemini-3.1-pro-preview";
  }
  if (id === "gemma-4-26b") {
    return normalizeGoogleModelId(id);
  }
  return id;
}

function googleFamilyModelId(id: string): string {
  const unqualified = id.startsWith(GOOGLE_PROVIDER_PREFIX)
    ? id.slice(GOOGLE_PROVIDER_PREFIX.length)
    : id;
  return unqualified.startsWith("models/") ? unqualified.slice("models/".length) : unqualified;
}

export function isGoogleTextGenerationModelId(id: string): boolean {
  const lower = normalizeOptionalLowercaseString(googleFamilyModelId(id)) ?? "";
  if (GOOGLE_NON_TEXT_MODEL_ID_MARKERS.some((marker) => lower.includes(marker))) {
    return false;
  }
  return GOOGLE_FORWARD_COMPAT_CASES.some((entry) => entry.match(lower));
}

/**
 * Gemini text models (not Gemma, tuned, image, speech, Live, or embedding models):
 * on AI Studio they default to Interactions and accept native video.
 */
export function isGoogleGeminiTextModelId(id: string): boolean {
  const lower = normalizeOptionalLowercaseString(googleFamilyModelId(id)) ?? "";
  return lower.startsWith("gemini-") && isGoogleTextGenerationModelId(lower);
}

export function resolveGoogleModelApi(params: {
  provider: string;
  modelId: string;
  api: string;
  baseUrl?: string;
  providerConfig?: ProviderResolveDynamicModelContext["providerConfig"];
}): string {
  if (params.provider !== "google") {
    return params.api;
  }
  const models = params.providerConfig?.models;
  const model =
    models?.find((entry) => entry.id === params.modelId) ??
    models?.find(
      (entry) =>
        normalizeGoogleModelId(stripGoogleProviderPrefix(entry.id)) ===
        normalizeGoogleModelId(stripGoogleProviderPrefix(params.modelId)),
    );
  // Only authored config is an explicit API choice; a catalog donor's API
  // describes its endpoint, not an operator's replacement endpoint.
  const explicitApi = model?.api ?? params.providerConfig?.api;
  if (explicitApi) {
    return explicitApi;
  }
  if (params.api !== "google-generative-ai" && params.api !== "google-interactions") {
    return params.api;
  }
  const baseUrl = model?.baseUrl ?? params.providerConfig?.baseUrl ?? params.baseUrl;
  return isOfficialGoogleAiStudioBaseUrl(baseUrl) && isGoogleGeminiTextModelId(params.modelId)
    ? "google-interactions"
    : "google-generative-ai";
}

type GoogleForwardCompatFamily = readonly [
  googleTemplateIds: readonly string[],
  cliTemplateIds: readonly string[],
  antigravityTemplateIds?: readonly string[],
  preferExternalFirstForCli?: boolean,
];

function isGoogleGeminiCliProvider(providerId: string): boolean {
  return normalizeOptionalLowercaseString(providerId) === GOOGLE_GEMINI_CLI_PROVIDER_ID;
}

function templateIdsForProvider(
  templateProviderId: string,
  family: GoogleForwardCompatFamily,
): readonly string[] {
  if (isGoogleGeminiCliProvider(templateProviderId)) {
    return family[1];
  }
  if (normalizeOptionalLowercaseString(templateProviderId) === GOOGLE_ANTIGRAVITY_PROVIDER_ID) {
    return family[2] ?? family[0];
  }
  return family[0];
}

type FamilyForwardCompatCase = Parameters<
  typeof resolveFamilyForwardCompatModel
>[0]["cases"][number];
type GoogleForwardCompatCase = Pick<FamilyForwardCompatCase, "patch"> & {
  match: (id: string) => boolean;
  family: GoogleForwardCompatFamily;
};

const GOOGLE_FORWARD_COMPAT_CASES: readonly GoogleForwardCompatCase[] = [
  {
    match: (id) => id.startsWith("gemini-2.5-pro"),
    family: [["gemini-2.5-pro"], GEMINI_3_1_PRO_TEMPLATE_IDS, undefined, true],
  },
  {
    match: (id) => id.startsWith("gemini-2.5-flash-lite"),
    family: [["gemini-2.5-flash-lite"], GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS, undefined, true],
  },
  {
    match: (id) => id.startsWith("gemini-2.5-flash"),
    family: [["gemini-2.5-flash"], GEMINI_3_1_FLASH_TEMPLATE_IDS, undefined, true],
  },
  {
    match: (id) => GEMINI_3_PRO_RE.test(id) || id === GEMINI_PRO_LATEST_ID,
    family: [
      GEMINI_3_1_PRO_TEMPLATE_IDS,
      GEMINI_3_1_PRO_TEMPLATE_IDS,
      ["gemini-3-pro-low", "gemini-3-pro-high"],
    ],
    patch: ({ providerId }) =>
      providerId === "google" || providerId === GOOGLE_GEMINI_CLI_PROVIDER_ID
        ? { reasoning: true }
        : undefined,
  },
  {
    match: (id) => GEMINI_3_FLASH_LITE_RE.test(id) || id === GEMINI_FLASH_LITE_LATEST_ID,
    family: [
      GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS,
      GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS,
      GEMINI_3_FLASH_ANTIGRAVITY_TEMPLATE_IDS,
    ],
  },
  {
    match: (id) => GEMINI_3_FLASH_RE.test(id) || id === GEMINI_FLASH_LATEST_ID,
    family: [
      GEMINI_3_1_FLASH_TEMPLATE_IDS,
      GEMINI_3_1_FLASH_TEMPLATE_IDS,
      GEMINI_3_FLASH_ANTIGRAVITY_TEMPLATE_IDS,
    ],
  },
  {
    match: (id) => GEMINI_4_RE.test(id),
    family: [GEMINI_4_TEMPLATE_IDS, GEMINI_4_TEMPLATE_IDS],
  },
  {
    match: (id) => id.startsWith(GEMMA_PREFIX),
    // Gemma has no dedicated catalog template; approximate with the Gemini flash family.
    family: [GEMINI_3_1_FLASH_TEMPLATE_IDS, GEMINI_3_1_FLASH_TEMPLATE_IDS],
    patch: ({ normalizedModelId }) =>
      normalizedModelId.startsWith("gemma-4") ? { reasoning: true } : undefined,
  },
];

// Live discovery copies per-model `compat` from the bundled static catalog.
// Resolve a discovered id to the static entry carrying the same weights:
// alias normalization, dated preview releases, and the -latest family aliases.
// Fail closed: an id that does not canonically resolve keeps no compat, so
// flags like codeMode are never enabled for unevaluated configurations.
export function resolveGoogleStaticModelId(
  id: string,
  staticIds: ReadonlySet<string>,
): string | undefined {
  const canonical = normalizeGoogleModelId(id);
  if (staticIds.has(canonical)) {
    return canonical;
  }
  // Dated releases publish the same weights under `<id>[-preview]-MM-DD`.
  const dateless = canonical.replace(/(?:-preview)?-\d{2}-\d{2}$/, "");
  if (dateless !== canonical) {
    const canonicalDateless = normalizeGoogleModelId(dateless);
    if (staticIds.has(canonicalDateless)) {
      return canonicalDateless;
    }
  }
  const isLatestAlias =
    canonical === GEMINI_PRO_LATEST_ID ||
    canonical === GEMINI_FLASH_LATEST_ID ||
    canonical === GEMINI_FLASH_LITE_LATEST_ID;
  if (!isLatestAlias) {
    return undefined;
  }
  // -latest aliases track the newest family member; reuse the family template
  // ordering instead of maintaining a parallel alias map.
  const familyCase = GOOGLE_FORWARD_COMPAT_CASES.find((entry) => entry.match(canonical));
  return familyCase?.family[0].find((templateId) => staticIds.has(templateId));
}

export function resolveGoogleGeminiForwardCompatModel(params: {
  providerId: string;
  ctx: ProviderResolveDynamicModelContext;
}): ProviderRuntimeModel | undefined {
  const trimmed = normalizeGeminiProRequestId(params.ctx.modelId.trim());
  const lower = normalizeOptionalLowercaseString(googleFamilyModelId(trimmed)) ?? "";

  return resolveFamilyForwardCompatModel({
    providerId: params.providerId,
    modelId: trimmed,
    normalizedModelId: isGoogleTextGenerationModelId(lower) ? lower : "",
    ctx: params.ctx,
    patch: { provider: params.providerId },
    cases: GOOGLE_FORWARD_COMPAT_CASES.map(({ family, match, patch }) => ({
      match,
      get templateSources() {
        const selectedProviderId = params.providerId;
        const defaultTemplateProviderId = isGoogleGeminiCliProvider(selectedProviderId)
          ? "google"
          : GOOGLE_GEMINI_CLI_PROVIDER_ID;
        const preferredExternalFirst =
          isGoogleGeminiCliProvider(selectedProviderId) && family[3] === true;
        const orderedTemplateProviderIds = preferredExternalFirst
          ? [defaultTemplateProviderId, selectedProviderId]
          : [selectedProviderId, defaultTemplateProviderId];
        return normalizeUniqueTrimmedStringList(orderedTemplateProviderIds).map((providerId) => ({
          providerId,
          templateIds: templateIdsForProvider(providerId, family),
        }));
      },
      patch: (context) => ({
        ...(typeof patch === "function" ? patch(context) : patch),
        ...(params.providerId === "google"
          ? {
              api: resolveGoogleModelApi({
                provider: params.providerId,
                modelId: trimmed,
                api: "google-generative-ai",
                baseUrl: context.template?.baseUrl,
                providerConfig:
                  params.ctx.providerConfig ??
                  resolveMergedModelProviderConfig(params.ctx.config, params.providerId),
              }),
            }
          : // A configured google row may carry Interactions; other providers never use it.
            context.template?.api === "google-interactions"
            ? { api: "google-generative-ai" }
            : {}),
      }),
    })),
  });
}

export function isModernGoogleModel(modelId: string): boolean {
  const lower = normalizeOptionalLowercaseString(modelId) ?? "";
  return (
    lower.startsWith("gemini-2.5") ||
    lower.startsWith("gemini-3") ||
    GEMINI_4_RE.test(lower) ||
    lower === GEMINI_PRO_LATEST_ID ||
    lower === GEMINI_FLASH_LATEST_ID ||
    lower === GEMINI_FLASH_LITE_LATEST_ID ||
    lower.startsWith(GEMMA_PREFIX)
  );
}
