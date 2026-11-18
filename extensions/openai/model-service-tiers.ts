import type { ProviderCatalogOutcome } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { OPENAI_CODEX_RESPONSES_BASE_URL } from "./base-url.js";

/** Only authenticated remote rows may supply this private observation, never fallback seeds. */
function readOpenAICodexServiceTiers(
  rows: readonly unknown[],
): NonNullable<ProviderCatalogOutcome["modelServiceTiers"]> {
  return rows.flatMap((row) => {
    const record = asOptionalRecord(row);
    const modelId = normalizeOptionalString(record?.slug) ?? normalizeOptionalString(record?.id);
    const tiers = record?.service_tiers;
    if (!modelId || !Array.isArray(tiers)) {
      return [];
    }
    const serviceTiers: string[] = [];
    for (const tier of tiers) {
      const id = normalizeOptionalString(asOptionalRecord(tier)?.id);
      if (!id) {
        return [];
      }
      serviceTiers.push(id);
    }
    return [
      {
        modelId,
        runtimeId: "codex",
        api: "openai-chatgpt-responses",
        baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
        serviceTiers: [...new Set(serviceTiers)],
      },
    ];
  });
}

/** Only explicit caller-specific metadata grants a program, never a model name or plan. */
export function readOpenAIModelAccessPrograms(
  rows: readonly unknown[],
  route: { api: string; baseUrl: string; runtimeIds: readonly string[] },
): NonNullable<ProviderCatalogOutcome["modelAccessPrograms"]> {
  return rows.flatMap((row) => {
    const record = asOptionalRecord(row);
    const modelId = normalizeOptionalString(record?.slug) ?? normalizeOptionalString(record?.id);
    const cyber = asOptionalRecord(record?.available_access_programs)?.cyber;
    if (
      !modelId ||
      !Array.isArray(cyber) ||
      !cyber.every((program) => typeof program === "string")
    ) {
      return [];
    }
    const programs = cyber.filter(
      (program): program is "standard" | "daybreak_blue" | "daybreak_red" =>
        program === "standard" || program === "daybreak_blue" || program === "daybreak_red",
    );
    return route.runtimeIds.map((runtimeId) => ({
      modelId,
      runtimeId,
      api: route.api,
      baseUrl: route.baseUrl,
      cyber: programs,
    }));
  });
}

/**
 * A successful account-scoped listing is authoritative even when every row is hidden; static
 * hints must not invent subscription access. Hidden rows stay listed: the account is entitled.
 */
export function buildOpenAICodexReadyOutcome(rows: readonly unknown[]): ProviderCatalogOutcome {
  const modelServiceTiers = readOpenAICodexServiceTiers(rows);
  const modelAccessPrograms = readOpenAIModelAccessPrograms(rows, {
    api: "openai-chatgpt-responses",
    baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
    runtimeIds: ["openclaw", "codex"],
  });
  return {
    provider: "openai",
    status: "ready",
    ...(modelServiceTiers.length ? { modelServiceTiers } : {}),
    ...(modelAccessPrograms.length ? { modelAccessPrograms } : {}),
    listedModelIds: rows.flatMap((row) => {
      const record = asOptionalRecord(row);
      return normalizeOptionalString(record?.slug) ?? normalizeOptionalString(record?.id) ?? [];
    }),
  };
}

export type OpenAILiveProviderCatalog = {
  provider: ModelProviderConfig;
  outcome?: ProviderCatalogOutcome;
};

export function projectOpenAICatalog(catalog: OpenAILiveProviderCatalog, profileId?: string) {
  const scopedProfileId = profileId?.trim();
  return {
    providers: { openai: catalog.provider },
    ...(catalog.outcome
      ? {
          outcomes: [
            scopedProfileId ? { ...catalog.outcome, profileId: scopedProfileId } : catalog.outcome,
          ],
        }
      : {}),
  };
}
