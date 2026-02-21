import { createFeishuClient } from "../client.js";
import {
  errorResult,
  json,
  runFeishuApiCall,
  type FeishuApiResponse,
} from "../tools-common/feishu-api.js";

export type BitableClient = ReturnType<typeof createFeishuClient>;

// SDK-derived payload types keep tool input strongly typed and aligned with upstream API changes.
type AppTableFieldCreatePayload = NonNullable<
  Parameters<BitableClient["bitable"]["appTableField"]["create"]>[0]
>;
type AppTableFieldUpdatePayload = NonNullable<
  Parameters<BitableClient["bitable"]["appTableField"]["update"]>[0]
>;
type AppCreatePayload = NonNullable<Parameters<BitableClient["bitable"]["app"]["create"]>[0]>;
type AppTableRecordCreatePayload = NonNullable<
  Parameters<BitableClient["bitable"]["appTableRecord"]["create"]>[0]
>;

export type BitableFieldCreateData = AppTableFieldCreatePayload["data"];
export type BitableFieldUpdateData = AppTableFieldUpdatePayload["data"];
export type BitableAppCreateData = NonNullable<AppCreatePayload["data"]>;
export type BitableFieldDescription = NonNullable<BitableFieldCreateData["description"]>;
export type BitableRecordFields = NonNullable<AppTableRecordCreatePayload["data"]>["fields"];

export { json, errorResult };

const RETRYABLE_BITABLE_ERROR_CODES = new Set<number>([
  1254607, // Data not ready
  1255040, // Request timeout
  1254290, // Too many requests
  1254291, // Write conflict
]);

const RETRY_BACKOFF_MS = [350, 900, 1800];

export async function runBitableApiCall<T extends FeishuApiResponse>(
  context: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Bitable APIs can briefly return "Data not ready" after writes.
  // Retry only known transient codes with short backoff.
  return runFeishuApiCall(context, fn, {
    retryableCodes: RETRYABLE_BITABLE_ERROR_CODES,
    backoffMs: RETRY_BACKOFF_MS,
  });
}

const FIELD_TYPE_NAMES: Record<number, string> = {
  1: "Text",
  2: "Number",
  3: "SingleSelect",
  4: "MultiSelect",
  5: "DateTime",
  7: "Checkbox",
  11: "User",
  13: "Phone",
  15: "URL",
  17: "Attachment",
  18: "SingleLink",
  19: "Lookup",
  20: "Formula",
  21: "DuplexLink",
  22: "Location",
  23: "GroupChat",
  1001: "CreatedTime",
  1002: "ModifiedTime",
  1003: "CreatedUser",
  1004: "ModifiedUser",
  1005: "AutoNumber",
};

export function formatField(field: {
  field_id?: string;
  field_name?: string;
  type?: number;
  is_primary?: boolean;
  property?: unknown;
  ui_type?: string;
  is_hidden?: boolean;
}) {
  const typeName =
    field.type != null ? FIELD_TYPE_NAMES[field.type] || `type_${field.type}` : undefined;
  const property =
    field.property && typeof field.property === "object" ? { property: field.property } : {};
  return {
    field_id: field.field_id,
    field_name: field.field_name,
    type: field.type,
    ...(typeName && { type_name: typeName }),
    is_primary: field.is_primary,
    ui_type: field.ui_type,
    is_hidden: field.is_hidden,
    ...property,
  };
}
