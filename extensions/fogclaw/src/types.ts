export interface Entity {
  text: string;
  label: string;
  start: number;
  end: number;
  confidence: number;
  source: "regex" | "gliner";
}

export type RedactStrategy = "token" | "mask" | "hash";

export type GuardrailAction = "redact" | "block" | "warn";

export interface FogClawConfig {
  enabled: boolean;
  guardrail_mode: GuardrailAction;
  redactStrategy: RedactStrategy;
  model: string;
  confidence_threshold: number;
  custom_entities: string[];
  entityActions: Record<string, GuardrailAction>;
}

export interface ScanResult {
  entities: Entity[];
  text: string;
}

export interface RedactResult {
  redacted_text: string;
  mapping: Record<string, string>;
  entities: Entity[];
}

export const CANONICAL_TYPE_MAP: Record<string, string> = {
  DOB: "DATE",
  ZIP: "ZIP_CODE",
  PER: "PERSON",
  ORG: "ORGANIZATION",
  GPE: "LOCATION",
  LOC: "LOCATION",
  FAC: "ADDRESS",
  PHONE_NUMBER: "PHONE",
  SOCIAL_SECURITY_NUMBER: "SSN",
  CREDIT_CARD_NUMBER: "CREDIT_CARD",
  DATE_OF_BIRTH: "DATE",
};

export function canonicalType(entityType: string): string {
  const normalized = entityType.toUpperCase().trim();
  return CANONICAL_TYPE_MAP[normalized] ?? normalized;
}
