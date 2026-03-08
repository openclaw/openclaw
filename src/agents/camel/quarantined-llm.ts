import type { ZodType } from "zod";
import type { CaMeLValue } from "./types.js";
import { deriveValue } from "./value.js";

type QuarantinedModelCall = (input: {
  instruction: string;
  untrustedData: string;
  model: string;
  outputSchema?: unknown;
}) => Promise<unknown>;

const defaultQuarantinedModelCall: QuarantinedModelCall = async () => {
  throw new Error("No quarantined model caller configured.");
};

function asString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

export function createQuarantinedQuery(
  modelCall: QuarantinedModelCall = defaultQuarantinedModelCall,
) {
  return async function queryQuarantined(
    instruction: string,
    untrustedData: CaMeLValue<string>,
    model: string,
    outputSchema?: unknown,
  ): Promise<CaMeLValue<string>> {
    const result = await modelCall({
      instruction,
      untrustedData: untrustedData.raw,
      model,
      outputSchema,
    });

    let parsed = result;
    if (outputSchema && typeof outputSchema === "object" && "safeParse" in outputSchema) {
      const schema = outputSchema as ZodType;
      const validated = schema.safeParse(result);
      if (!validated.success) {
        throw new Error("Quarantined model output schema validation failed");
      }
      parsed = validated.data;
    }

    return deriveValue(asString(parsed), untrustedData);
  };
}

export async function queryQuarantined(
  instruction: string,
  untrustedData: CaMeLValue<string>,
  model: string,
  outputSchema?: unknown,
): Promise<CaMeLValue<string>> {
  const runQuery = createQuarantinedQuery();
  return runQuery(instruction, untrustedData, model, outputSchema);
}
