import type {
  BitableClient,
  BitableFieldCreateData,
  BitableFieldUpdateData,
  BitableRecordFields,
} from "./common.js";
import { formatField, runBitableApiCall } from "./common.js";

// -------- Field operations --------

export async function listFields(client: BitableClient, appToken: string, tableId: string) {
  const res = await runBitableApiCall("bitable.appTableField.list", () =>
    client.bitable.appTableField.list({
      path: { app_token: appToken, table_id: tableId },
    }),
  );

  const fields = res.data?.items ?? [];
  return {
    fields: fields.map((f) => formatField(f)),
    total: fields.length,
  };
}

export async function createField(
  client: BitableClient,
  appToken: string,
  tableId: string,
  field: BitableFieldCreateData,
) {
  const res = await runBitableApiCall("bitable.appTableField.create", () =>
    client.bitable.appTableField.create({
      path: { app_token: appToken, table_id: tableId },
      data: field,
    }),
  );

  return {
    field: res.data?.field ? formatField(res.data.field) : undefined,
  };
}

export async function updateField(
  client: BitableClient,
  appToken: string,
  tableId: string,
  fieldId: string,
  field: BitableFieldUpdateData,
) {
  const res = await runBitableApiCall("bitable.appTableField.update", () =>
    client.bitable.appTableField.update({
      path: { app_token: appToken, table_id: tableId, field_id: fieldId },
      data: field,
    }),
  );

  return {
    field: res.data?.field ? formatField(res.data.field) : undefined,
  };
}

export async function deleteField(
  client: BitableClient,
  appToken: string,
  tableId: string,
  fieldId: string,
) {
  const res = await runBitableApiCall("bitable.appTableField.delete", () =>
    client.bitable.appTableField.delete({
      path: { app_token: appToken, table_id: tableId, field_id: fieldId },
    }),
  );

  return {
    success: res.data?.deleted ?? true,
    field_id: res.data?.field_id ?? fieldId,
    deleted: res.data?.deleted ?? true,
  };
}

// -------- Record operations --------

export async function listRecords(
  client: BitableClient,
  appToken: string,
  tableId: string,
  pageSize?: number,
  pageToken?: string,
) {
  const res = await runBitableApiCall("bitable.appTableRecord.list", () =>
    client.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: tableId },
      params: {
        page_size: pageSize ?? 100,
        ...(pageToken && { page_token: pageToken }),
      },
    }),
  );

  return {
    records: res.data?.items ?? [],
    has_more: res.data?.has_more ?? false,
    page_token: res.data?.page_token,
    total: res.data?.total,
  };
}

export async function getRecord(
  client: BitableClient,
  appToken: string,
  tableId: string,
  recordId: string,
) {
  const res = await runBitableApiCall("bitable.appTableRecord.get", () =>
    client.bitable.appTableRecord.get({
      path: { app_token: appToken, table_id: tableId, record_id: recordId },
    }),
  );

  return {
    record: res.data?.record,
  };
}

export async function createRecord(
  client: BitableClient,
  appToken: string,
  tableId: string,
  fields: BitableRecordFields,
) {
  const res = await runBitableApiCall("bitable.appTableRecord.create", () =>
    client.bitable.appTableRecord.create({
      path: { app_token: appToken, table_id: tableId },
      data: { fields },
    }),
  );

  return {
    record: res.data?.record,
  };
}

export async function updateRecord(
  client: BitableClient,
  appToken: string,
  tableId: string,
  recordId: string,
  fields: BitableRecordFields,
) {
  const res = await runBitableApiCall("bitable.appTableRecord.update", () =>
    client.bitable.appTableRecord.update({
      path: { app_token: appToken, table_id: tableId, record_id: recordId },
      data: { fields },
    }),
  );

  return {
    record: res.data?.record,
  };
}

export async function deleteRecord(
  client: BitableClient,
  appToken: string,
  tableId: string,
  recordId: string,
) {
  const res = await runBitableApiCall("bitable.appTableRecord.delete", () =>
    client.bitable.appTableRecord.delete({
      path: { app_token: appToken, table_id: tableId, record_id: recordId },
    }),
  );

  return {
    success: res.data?.deleted ?? true,
    record_id: res.data?.record_id ?? recordId,
    deleted: res.data?.deleted ?? true,
  };
}

export async function batchDeleteRecords(
  client: BitableClient,
  appToken: string,
  tableId: string,
  recordIds: string[],
) {
  const res = await runBitableApiCall("bitable.appTableRecord.batchDelete", () =>
    client.bitable.appTableRecord.batchDelete({
      path: { app_token: appToken, table_id: tableId },
      data: { records: recordIds },
    }),
  );

  const results = res.data?.records ?? [];
  return {
    results,
    requested: recordIds.length,
    deleted: results.filter((r) => r.deleted).length,
  };
}
