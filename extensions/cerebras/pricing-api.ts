import {
  normalizeModelPricingCatalog,
  normalizeOpenRouterModelPricing,
} from "openclaw/plugin-sdk/model-catalog-pricing";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function normalizeCerebrasModelPricing(value: unknown) {
  const pricing = asOptionalRecord(value);
  // Native cache reads cost the regular input rate unless the feed supplies a tariff.
  return pricing
    ? normalizeOpenRouterModelPricing({
        ...pricing,
        input_cache_read: pricing.input_cache_read ?? pricing.prompt,
      })
    : undefined;
}

export function parseCerebrasPricingCatalog(payload: unknown) {
  return normalizeModelPricingCatalog(
    asOptionalRecord(payload)?.data,
    normalizeCerebrasModelPricing,
  );
}
