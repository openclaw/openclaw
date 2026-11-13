import type { TLocalizedValidationError } from "typebox/error";
import { Errors, Pointer } from "typebox/schema";
/** Validation for authored and generated model registry catalogs. */
import type { ProviderModelCatalog } from "../models-config.merge.js";
import { ModelRegistryConfigSchema } from "./model-registry-schema-definition.js";
import { isModelsConfig } from "./model-registry-validator.generated.js";

export type { ModelsConfig, ProviderAuthMode } from "./model-registry-schema-definition.js";

export const validateModelsConfig = {
  Check: isModelsConfig,
  Errors: (value: unknown) => Errors(ModelRegistryConfigSchema, value)[1],
};

/** Omit malformed pricing, retaining the rows for semantic validation before exclusion. */
export function omitInvalidModelCosts(value: unknown): Set<unknown> {
  const paths = new Set<string>();
  for (const error of validateModelsConfig.Errors(value)) {
    const match = /^(\/providers\/[^/]+\/models\/\d+)\/cost(?:\/|$)/.exec(error.instancePath);
    if (!match?.[1]) {
      return new Set();
    }
    paths.add(match[1]);
  }
  const models = new Set<unknown>();
  for (const modelPath of paths) {
    models.add(Pointer.Get(value, modelPath));
    Pointer.Delete(value, `${modelPath}/cost`);
  }
  return models;
}

export function formatValidationPath(error: TLocalizedValidationError): string {
  const path = Pointer.Indices(error.instancePath).join(".").replace(/\//g, ".");
  if (error.keyword === "required") {
    const requiredProperty = error.params.requiredProperties[0];
    if (requiredProperty) {
      return path ? `${path}.${requiredProperty}` : requiredProperty;
    }
  }
  return path || "root";
}

export function validateProviderModels(
  providerName: string,
  config: ProviderModelCatalog,
  source: "catalog" | "registration",
): void {
  const models = config.models ?? [];
  if (models.length > 0 && !config.baseUrl) {
    const subject = source === "catalog" ? "custom models" : "models";
    throw new Error(`Provider ${providerName}: "baseUrl" is required when defining ${subject}.`);
  }
  for (const model of models) {
    if (!model.api && !config.api) {
      const guidance = source === "catalog" ? " Set at provider or model level." : "";
      throw new Error(
        `Provider ${providerName}, model ${model.id}: no "api" specified.${guidance}`,
      );
    }
    if (source === "catalog") {
      for (const field of ["contextWindow", "maxTokens"] as const) {
        if (model[field] !== undefined && model[field] <= 0) {
          throw new Error(`Provider ${providerName}, model ${model.id}: invalid ${field}`);
        }
      }
    }
  }
}
