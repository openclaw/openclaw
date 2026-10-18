import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import {
  resolveCrmConfig,
  resolveCrmToolConfig,
  type CrmConfig,
  type CrmToolConfigContext,
} from "./config.js";

export const ENTITIES = ["contact", "company", "deal"] as const;
export type CrmEntity = (typeof ENTITIES)[number];

export const ENTITY_PATH: Record<CrmEntity, string> = {
  contact: "contacts",
  company: "companies",
  deal: "deals",
};

export const DEAL_STAGES = [
  "DEMO_BOOKED",
  "QUALIFIED_TO_BUY",
  "UNQUALIFIED_TO_BUY",
  "DECISION_MAKER_BOUGHT_IN",
  "CONTRACT_SENT",
  "CLOSED_WON",
  "CLOSED_LOST",
] as const;

export const ACTIVITY_TYPES = ["note", "call", "email", "meeting", "task"] as const;
export type CrmActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_TYPE_TO_API: Record<CrmActivityType, string> = {
  note: "NOTE",
  call: "CALL",
  email: "EMAIL",
  meeting: "MEETING",
  task: "TASK",
};

export const TIMELINE_FILTERS = [
  "all",
  "history",
  "notes",
  "upcoming",
  "done",
  "email",
  "meetings",
] as const;

export const LIST_FILTERS: Record<CrmEntity, ReadonlySet<string>> = {
  contact: new Set(["owner", "company", "source", "title", "seniority", "persona", "activity"]),
  company: new Set(["owner", "industry", "enrichment", "source", "activity"]),
  deal: new Set(["status", "owner", "stage", "closing"]),
};

export const CREATE_FIELDS: Record<CrmEntity, ReadonlySet<string>> = {
  contact: new Set(["firstName", "lastName", "email", "phone", "title", "companyId", "ownerId"]),
  company: new Set(["name", "domain", "ownerId"]),
  deal: new Set([
    "name",
    "companyId",
    "ownerId",
    "stage",
    "amountCents",
    "currency",
    "expectedCloseDate",
  ]),
};

export const UPDATE_FIELDS: Record<CrmEntity, ReadonlySet<string>> = {
  contact: new Set([
    "firstName",
    "lastName",
    "email",
    "phone",
    "title",
    "linkedinUrl",
    "twitterUrl",
    "githubUrl",
    "companyId",
    "ownerId",
  ]),
  company: new Set([
    "name",
    "domain",
    "website",
    "description",
    "industry",
    "city",
    "stateCode",
    "country",
    "phone",
    "email",
    "linkedinUrl",
    "ownerId",
  ]),
  deal: new Set([
    "name",
    "description",
    "companyId",
    "ownerId",
    "amountCents",
    "currency",
    "expectedCloseDate",
    "stage",
    "closedReason",
  ]),
};

export const entitySchema = Type.Union(
  [Type.Literal("contact"), Type.Literal("company"), Type.Literal("deal")],
  { description: "Record kind to operate on." },
);

export const nonEmptyString = (description: string) => Type.String({ minLength: 1, description });

export const listFiltersSchema = Type.Optional(
  Type.Record(nonEmptyString("Filter key."), Type.Array(Type.String()), {
    description:
      "Filter arrays keyed by the CRM list filters: contacts (owner, company, source, title, seniority, persona, activity), companies (owner, industry, enrichment, source, activity), deals (status, owner, stage, closing).",
  }),
);

export function readEntity(params: Record<string, unknown>): CrmEntity {
  const value = params.entity;
  if (value === "contact" || value === "company" || value === "deal") {
    return value;
  }
  throw new Error('entity must be "contact", "company", or "deal".');
}

export function readRequiredString(
  params: Record<string, unknown>,
  key: string,
  description: string,
): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required: ${description}`);
  }
  return value.trim();
}

export function readCrmTextParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string.`);
  }
  return normalizeOptionalString(value);
}

export function readOptionalInteger(
  params: Record<string, unknown>,
  key: string,
  bounds: { min: number; max: number },
): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < bounds.min ||
    value > bounds.max
  ) {
    throw new Error(`${key} must be an integer from ${bounds.min} to ${bounds.max}.`);
  }
  return value;
}

export function readOptionalBoolean(
  params: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean.`);
  }
  return value;
}

export function readOptionalRecord(
  params: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  const record = asOptionalRecord(value);
  if (!record) {
    throw new Error(`${key} must be an object.`);
  }
  return record;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return undefined;
    }
    const trimmed = entry.trim();
    if (trimmed) {
      values.push(trimmed);
    }
  }
  return values;
}

export function readFilters(
  params: Record<string, unknown>,
  entity: CrmEntity,
): Record<string, string[]> | undefined {
  const raw = readOptionalRecord(params, "filters");
  if (!raw) {
    return undefined;
  }

  const allowed = LIST_FILTERS[entity];
  const filters: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.has(key)) {
      throw new Error(
        `filters.${key} is not supported for ${entity}s. Allowed filters: ${[...allowed].join(", ")}.`,
      );
    }
    const values = normalizeStringArray(value);
    if (!values) {
      throw new Error(`filters.${key} must be an array of strings.`);
    }
    if (values.length > 0) {
      filters[key] = values;
    }
  }
  return filters;
}

export function readData(
  params: Record<string, unknown>,
  entity: CrmEntity,
  mode: "create" | "update",
): Record<string, unknown> {
  const data = readOptionalRecord(params, "data");
  if (!data) {
    throw new Error(`data is required: pass the ${entity} fields as an object.`);
  }

  const allowed = mode === "create" ? CREATE_FIELDS[entity] : UPDATE_FIELDS[entity];
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) {
      throw new Error(
        `data.${key} is not supported when ${mode === "create" ? "creating" : "updating"} a ${entity}. Allowed fields: ${[...allowed].join(", ")}.`,
      );
    }
  }
  return data;
}

export function requireField(data: Record<string, unknown>, key: string, entity: CrmEntity): void {
  const value = data[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${entity} data.${key} is required.`);
  }
}

export function requireDealStage(value: unknown): string {
  if (typeof value !== "string" || !isDealStage(value)) {
    throw new Error(`stage must be one of: ${DEAL_STAGES.join(", ")}.`);
  }
  return value;
}

function isDealStage(value: string): value is (typeof DEAL_STAGES)[number] {
  return DEAL_STAGES.some((stage) => stage === value);
}

export function readActivityType(params: Record<string, unknown>): CrmActivityType {
  const value = params.type;
  if (typeof value === "string" && isCrmActivityType(value)) {
    return value;
  }
  throw new Error(`type must be one of: ${ACTIVITY_TYPES.join(", ")}.`);
}

function isCrmActivityType(value: string): value is CrmActivityType {
  return ACTIVITY_TYPES.some((type) => type === value);
}

export function readTimelineFilter(params: Record<string, unknown>): string | undefined {
  const value = params.filter;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !isTimelineFilter(value)) {
    throw new Error(`filter must be one of: ${TIMELINE_FILTERS.join(", ")}.`);
  }
  return value;
}

function isTimelineFilter(value: string): value is (typeof TIMELINE_FILTERS)[number] {
  return TIMELINE_FILTERS.some((filter) => filter === value);
}

export function createConfig(api: OpenClawPluginApi, ctx?: CrmToolConfigContext): CrmConfig {
  return resolveCrmConfig(resolveCrmToolConfig(api, ctx));
}
