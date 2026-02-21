import type {
  BitableAppCreateData,
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

type CleanupLogger = {
  debug: (msg: string) => void;
  warn: (msg: string) => void;
};

const DEFAULT_CLEANUP_FIELD_TYPES = new Set([3, 5, 17]); // SingleSelect, DateTime, Attachment

async function cleanupNewBitable(
  client: BitableClient,
  appToken: string,
  tableId: string,
  tableName: string,
  logger: CleanupLogger,
): Promise<{ cleanedRows: number; cleanedFields: number }> {
  let cleanedRows = 0;
  let cleanedFields = 0;

  try {
    const fieldsRes = await runBitableApiCall("bitable.appTableField.list", () =>
      client.bitable.appTableField.list({
        path: { app_token: appToken, table_id: tableId },
      }),
    );
    const fields = fieldsRes.data?.items ?? [];

    const primaryField = fields.find((f) => f.is_primary);
    if (primaryField?.field_id) {
      try {
        const newFieldName = tableName.length <= 20 ? tableName : "Name";
        await runBitableApiCall("bitable.appTableField.update", () =>
          client.bitable.appTableField.update({
            path: {
              app_token: appToken,
              table_id: tableId,
              field_id: primaryField.field_id!,
            },
            data: {
              field_name: newFieldName,
              type: 1,
            },
          }),
        );
        cleanedFields++;
      } catch (err) {
        logger.debug(`Failed to rename primary field: ${String(err)}`);
      }
    }

    const defaultFieldsToDelete = fields.filter(
      (field) => !field.is_primary && DEFAULT_CLEANUP_FIELD_TYPES.has(field.type ?? 0),
    );
    for (const field of defaultFieldsToDelete) {
      if (!field.field_id) continue;
      try {
        await runBitableApiCall("bitable.appTableField.delete", () =>
          client.bitable.appTableField.delete({
            path: {
              app_token: appToken,
              table_id: tableId,
              field_id: field.field_id!,
            },
          }),
        );
        cleanedFields++;
      } catch (err) {
        logger.debug(`Failed to delete default field ${field.field_name}: ${String(err)}`);
      }
    }
  } catch (err) {
    logger.warn(`Failed to inspect fields for cleanup: ${String(err)}`);
  }

  try {
    const recordsRes = await runBitableApiCall("bitable.appTableRecord.list", () =>
      client.bitable.appTableRecord.list({
        path: { app_token: appToken, table_id: tableId },
        params: { page_size: 100 },
      }),
    );
    const records = recordsRes.data?.items ?? [];

    const emptyRecordIds = records
      .filter((record) => !record.fields || Object.keys(record.fields).length === 0)
      .map((record) => record.record_id)
      .filter((recordId): recordId is string => Boolean(recordId));

    if (emptyRecordIds.length > 0) {
      try {
        await runBitableApiCall("bitable.appTableRecord.batchDelete", () =>
          client.bitable.appTableRecord.batchDelete({
            path: { app_token: appToken, table_id: tableId },
            data: { records: emptyRecordIds },
          }),
        );
        cleanedRows = emptyRecordIds.length;
      } catch {
        for (const recordId of emptyRecordIds) {
          try {
            await runBitableApiCall("bitable.appTableRecord.delete", () =>
              client.bitable.appTableRecord.delete({
                path: { app_token: appToken, table_id: tableId, record_id: recordId },
              }),
            );
            cleanedRows++;
          } catch (err) {
            logger.debug(`Failed to delete empty row ${recordId}: ${String(err)}`);
          }
        }
      }
    }
  } catch (err) {
    logger.warn(`Failed to inspect placeholder rows for cleanup: ${String(err)}`);
  }

  return { cleanedRows, cleanedFields };
}

export async function createApp(
  client: BitableClient,
  name: BitableAppCreateData["name"],
  folderToken?: BitableAppCreateData["folder_token"],
  logger?: CleanupLogger,
) {
  const res = await runBitableApiCall("bitable.app.create", () =>
    client.bitable.app.create({
      data: {
        name,
        ...(folderToken && { folder_token: folderToken }),
      },
    }),
  );

  const appToken = res.data?.app?.app_token;
  if (!appToken) {
    throw new Error("Failed to create Bitable: no app_token returned");
  }

  const log: CleanupLogger = logger ?? { debug: () => {}, warn: () => {} };
  let tableId: string | undefined;
  let cleanedRows = 0;
  let cleanedFields = 0;

  try {
    const tablesRes = await runBitableApiCall("bitable.appTable.list", () =>
      client.bitable.appTable.list({
        path: { app_token: appToken },
      }),
    );
    const firstTable = tablesRes.data?.items?.[0];
    tableId = firstTable?.table_id ?? undefined;

    if (tableId) {
      const cleanup = await cleanupNewBitable(client, appToken, tableId, String(name), log);
      cleanedRows = cleanup.cleanedRows;
      cleanedFields = cleanup.cleanedFields;
    }
  } catch (err) {
    log.debug(`Cleanup failed (non-critical): ${String(err)}`);
  }

  return {
    app_token: appToken,
    table_id: tableId,
    name: res.data?.app?.name,
    url: res.data?.app?.url,
    cleaned_placeholder_rows: cleanedRows,
    cleaned_default_fields: cleanedFields,
    hint: tableId
      ? `Table created. Use app_token="${appToken}" and table_id="${tableId}" for other bitable tools.`
      : "Table created. Use feishu_bitable_get_meta to get table_id and field details.",
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
