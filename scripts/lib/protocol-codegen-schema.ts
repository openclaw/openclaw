export type JsonSchema = {
  "~openclawClosedObjectIdentity"?: symbol;
  type?: string | string[];
  const?: boolean | number | string | null;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<boolean | number | string | null>;
  patternProperties?: Record<string, JsonSchema>;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
};

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJson);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted()
        .map((key) => [key, stableJson(record[key])]),
    );
  }
  return value;
}

export function schemaSignature(schema: JsonSchema): string {
  return JSON.stringify(stableJson(schema));
}
