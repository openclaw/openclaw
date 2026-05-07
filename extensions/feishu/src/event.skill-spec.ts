import { isRecord, readString } from "./comment-shared.js";
import type { FeishuEventRoute, NormalizedFeishuEventCategory } from "./event.model.js";
import type { FeishuEventTriggerMode } from "./event.trigger.js";

export const FEISHU_SKILL_SUBSCRIBERS_FILENAME = "feishu-event.subscribers.json";
export const FEISHU_SKILL_SUBSCRIBERS_VERSION = 1;

const FEISHU_EVENT_CATEGORY_VALUES = [
  "im.message",
  "im.chat",
  "drive.comment",
  "drive.file",
  "bitable.record",
  "bitable.field",
  "approval.instance",
  "calendar.calendar",
  "calendar.event",
  "card.action",
  "application.bot.menu",
  "contact",
  "vc.meeting",
  "custom",
] as const satisfies readonly NormalizedFeishuEventCategory[];

const FEISHU_EVENT_ROUTE_VALUES = [
  "direct",
  "publish",
] as const satisfies readonly FeishuEventRoute[];
const FEISHU_EVENT_TRIGGER_MODE_VALUES = [
  "main",
  "isolated",
  "custom",
] as const satisfies readonly FeishuEventTriggerMode[];

export type FeishuSkillSubscriberMatchSpec = {
  topics?: readonly string[];
  eventTypes?: readonly string[];
  categories?: readonly NormalizedFeishuEventCategory[];
  subtypes?: readonly string[];
  accountIds?: readonly string[];
  route?: FeishuEventRoute;
  sourceIdPrefix?: string;
};

export type FeishuSkillSubscriberTriggerSpec = {
  mode?: FeishuEventTriggerMode;
  prompt: string;
  sessionKey?: string;
  command?: string;
  includeRawPayload?: boolean;
};

export type FeishuSkillSubscriberHandlerSpec = {
  file: string;
  exportName?: string;
};

export type FeishuSkillSubscriberDeliverySpec = {
  concurrencyLimit?: number;
};

export type FeishuSkillSubscriberDefinition = {
  id: string;
  enabled: boolean;
  targetAgentId?: string;
  match?: FeishuSkillSubscriberMatchSpec;
  trigger?: FeishuSkillSubscriberTriggerSpec;
  handler?: FeishuSkillSubscriberHandlerSpec;
  delivery?: FeishuSkillSubscriberDeliverySpec;
};

export type FeishuSkillSubscriberFileSpec = {
  version: typeof FEISHU_SKILL_SUBSCRIBERS_VERSION;
  subscribers: readonly FeishuSkillSubscriberDefinition[];
};

export type FeishuSkillSubscriberSpecError = {
  path: string;
  message: string;
};

type ParseResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      errors: FeishuSkillSubscriberSpecError[];
    };

function pushError(errors: FeishuSkillSubscriberSpecError[], path: string, message: string): void {
  errors.push({ path, message });
}

function parseRequiredString(
  value: unknown,
  path: string,
  errors: FeishuSkillSubscriberSpecError[],
): string | undefined {
  const parsed = readString(value)?.trim();
  if (!parsed) {
    pushError(errors, path, "must be a non-empty string");
    return undefined;
  }
  return parsed;
}

function parseOptionalString(
  value: unknown,
  path: string,
  errors: FeishuSkillSubscriberSpecError[],
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = readString(value)?.trim();
  if (!parsed) {
    pushError(errors, path, "must be a non-empty string when provided");
    return undefined;
  }
  return parsed;
}

function parseOptionalBoolean(
  value: unknown,
  path: string,
  errors: FeishuSkillSubscriberSpecError[],
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    pushError(errors, path, "must be a boolean when provided");
    return undefined;
  }
  return value;
}

function parseOptionalPositiveInteger(
  value: unknown,
  path: string,
  errors: FeishuSkillSubscriberSpecError[],
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    pushError(errors, path, "must be a positive integer when provided");
    return undefined;
  }
  return value;
}

function parseOptionalStringArray(
  value: unknown,
  path: string,
  errors: FeishuSkillSubscriberSpecError[],
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    pushError(errors, path, "must be an array of strings when provided");
    return undefined;
  }
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = readString(item)?.trim();
    if (!parsed) {
      pushError(errors, `${path}[${index}]`, "must be a non-empty string");
      continue;
    }
    result.push(parsed);
  }
  return result.length > 0 ? result : undefined;
}

function parseOptionalEnum<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  path: string,
  errors: FeishuSkillSubscriberSpecError[],
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = readString(value)?.trim();
  if (!parsed || !allowedValues.includes(parsed as T)) {
    pushError(errors, path, `must be one of: ${allowedValues.join(", ")}`);
    return undefined;
  }
  return parsed as T;
}

function parseOptionalEnumArray<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  path: string,
  errors: FeishuSkillSubscriberSpecError[],
): readonly T[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    pushError(errors, path, `must be an array with values from: ${allowedValues.join(", ")}`);
    return undefined;
  }
  const result: T[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = readString(item)?.trim();
    if (!parsed || !allowedValues.includes(parsed as T)) {
      pushError(errors, `${path}[${index}]`, `must be one of: ${allowedValues.join(", ")}`);
      continue;
    }
    result.push(parsed as T);
  }
  return result.length > 0 ? result : undefined;
}

function parseSubscriberMatchSpec(
  value: unknown,
  path: string,
  errors: FeishuSkillSubscriberSpecError[],
): FeishuSkillSubscriberMatchSpec | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    pushError(errors, path, "must be an object when provided");
    return undefined;
  }
  const match: FeishuSkillSubscriberMatchSpec = {
    topics: parseOptionalStringArray(value.topics, `${path}.topics`, errors),
    eventTypes: parseOptionalStringArray(value.eventTypes, `${path}.eventTypes`, errors),
    categories: parseOptionalEnumArray(
      value.categories,
      FEISHU_EVENT_CATEGORY_VALUES,
      `${path}.categories`,
      errors,
    ),
    subtypes: parseOptionalStringArray(value.subtypes, `${path}.subtypes`, errors),
    accountIds: parseOptionalStringArray(value.accountIds, `${path}.accountIds`, errors),
    route: parseOptionalEnum(value.route, FEISHU_EVENT_ROUTE_VALUES, `${path}.route`, errors),
    sourceIdPrefix: parseOptionalString(value.sourceIdPrefix, `${path}.sourceIdPrefix`, errors),
  };
  return Object.values(match).some((entry) => entry !== undefined) ? match : undefined;
}

function parseSubscriberTriggerSpec(
  value: unknown,
  path: string,
  errors: FeishuSkillSubscriberSpecError[],
): FeishuSkillSubscriberTriggerSpec | undefined {
  if (!isRecord(value)) {
    pushError(errors, path, "must be an object");
    return undefined;
  }
  const mode = parseOptionalEnum(
    value.mode,
    FEISHU_EVENT_TRIGGER_MODE_VALUES,
    `${path}.mode`,
    errors,
  );
  const prompt = parseRequiredString(value.prompt, `${path}.prompt`, errors);
  const sessionKey = parseOptionalString(value.sessionKey, `${path}.sessionKey`, errors);
  const command = parseOptionalString(value.command, `${path}.command`, errors);
  const includeRawPayload = parseOptionalBoolean(
    value.includeRawPayload,
    `${path}.includeRawPayload`,
    errors,
  );
  if (!prompt) {
    return undefined;
  }
  return {
    mode,
    prompt,
    sessionKey,
    command,
    includeRawPayload,
  };
}

function parseSubscriberHandlerSpec(
  value: unknown,
  path: string,
  errors: FeishuSkillSubscriberSpecError[],
): FeishuSkillSubscriberHandlerSpec | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    pushError(errors, path, "must be an object when provided");
    return undefined;
  }
  const file = parseRequiredString(value.file, `${path}.file`, errors);
  if (!file) {
    return undefined;
  }
  return {
    file,
    exportName: parseOptionalString(value.exportName, `${path}.exportName`, errors),
  };
}

function parseSubscriberDeliverySpec(
  value: unknown,
  path: string,
  errors: FeishuSkillSubscriberSpecError[],
): FeishuSkillSubscriberDeliverySpec | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    pushError(errors, path, "must be an object when provided");
    return undefined;
  }
  const delivery: FeishuSkillSubscriberDeliverySpec = {
    concurrencyLimit: parseOptionalPositiveInteger(
      value.concurrencyLimit,
      `${path}.concurrencyLimit`,
      errors,
    ),
  };
  return Object.values(delivery).some((entry) => entry !== undefined) ? delivery : undefined;
}

function parseSubscriberDefinition(
  value: unknown,
  path: string,
  errors: FeishuSkillSubscriberSpecError[],
): FeishuSkillSubscriberDefinition | undefined {
  if (!isRecord(value)) {
    pushError(errors, path, "must be an object");
    return undefined;
  }
  const id = parseRequiredString(value.id, `${path}.id`, errors);
  const targetAgentId = parseOptionalString(value.targetAgentId, `${path}.targetAgentId`, errors);
  const trigger =
    value.trigger === undefined
      ? undefined
      : parseSubscriberTriggerSpec(value.trigger, `${path}.trigger`, errors);
  const handler = parseSubscriberHandlerSpec(value.handler, `${path}.handler`, errors);
  const match = parseSubscriberMatchSpec(value.match, `${path}.match`, errors);
  const delivery = parseSubscriberDeliverySpec(value.delivery, `${path}.delivery`, errors);
  if (!id) {
    return undefined;
  }
  if (!trigger && !handler) {
    pushError(errors, path, "must define at least one of trigger or handler");
  }
  if (trigger && !targetAgentId) {
    pushError(
      errors,
      `${path}.targetAgentId`,
      "must be a non-empty string when trigger is configured",
    );
  }
  if (
    (!trigger && value.trigger !== undefined) ||
    (!handler && value.handler !== undefined) ||
    (!trigger && !handler) ||
    (trigger && !targetAgentId)
  ) {
    return undefined;
  }
  return {
    id,
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    targetAgentId,
    match,
    trigger,
    handler,
    delivery,
  };
}

export function parseFeishuSkillSubscriberSpec(
  value: unknown,
): ParseResult<FeishuSkillSubscriberFileSpec> {
  const errors: FeishuSkillSubscriberSpecError[] = [];
  if (!isRecord(value)) {
    return {
      ok: false,
      errors: [{ path: "$", message: "must be an object" }],
    };
  }
  const version = value.version;
  if (version !== FEISHU_SKILL_SUBSCRIBERS_VERSION) {
    pushError(errors, "$.version", `must equal ${String(FEISHU_SKILL_SUBSCRIBERS_VERSION)}`);
  }
  if (!Array.isArray(value.subscribers)) {
    pushError(errors, "$.subscribers", "must be an array");
    return { ok: false, errors };
  }
  const subscribers: FeishuSkillSubscriberDefinition[] = [];
  for (const [index, item] of value.subscribers.entries()) {
    const parsed = parseSubscriberDefinition(item, `$.subscribers[${index}]`, errors);
    if (parsed) {
      subscribers.push(parsed);
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      version: FEISHU_SKILL_SUBSCRIBERS_VERSION,
      subscribers,
    },
  };
}

export function parseFeishuSkillSubscriberSpecJson(
  content: string,
): ParseResult<FeishuSkillSubscriberFileSpec> {
  try {
    return parseFeishuSkillSubscriberSpec(JSON.parse(content) as unknown);
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          path: "$",
          message: error instanceof Error ? error.message : "invalid JSON",
        },
      ],
    };
  }
}

export function validateFeishuSkillSubscriberSpec(
  value: unknown,
): readonly FeishuSkillSubscriberSpecError[] {
  const parsed = parseFeishuSkillSubscriberSpec(value);
  return parsed.ok ? [] : parsed.errors;
}
