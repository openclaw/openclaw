import type { TSchema } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  hasFeishuToolEnabledForAnyAccount,
  withFeishuToolClient,
} from "../tools-common/tool-exec.js";
import {
  batchDeleteRecords,
  createApp,
  createField,
  createRecord,
  deleteField,
  deleteRecord,
  getRecord,
  listFields,
  listRecords,
  updateField,
  updateRecord,
} from "./actions.js";
import { errorResult, json, type BitableClient, type BitableRecordFields } from "./common.js";
import { getBitableMeta } from "./meta.js";
import {
  BatchDeleteRecordsSchema,
  type BatchDeleteRecordsParams,
  CreateAppSchema,
  type CreateAppParams,
  CreateFieldSchema,
  type CreateFieldParams,
  CreateRecordSchema,
  type CreateRecordParams,
  DeleteFieldSchema,
  type DeleteFieldParams,
  DeleteRecordSchema,
  type DeleteRecordParams,
  GetMetaSchema,
  type GetMetaParams,
  GetRecordSchema,
  type GetRecordParams,
  ListFieldsSchema,
  type ListFieldsParams,
  ListRecordsSchema,
  type ListRecordsParams,
  UpdateFieldSchema,
  type UpdateFieldParams,
  UpdateRecordSchema,
  type UpdateRecordParams,
} from "./schemas.js";

type ToolSpec<P> = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  run: (client: BitableClient, params: P) => Promise<unknown>;
};

// Shared registration wrapper keeps all bitable tools consistent:
// same response envelope and same error conversion path.
function registerBitableTool<P>(api: OpenClawPluginApi, spec: ToolSpec<P>) {
  api.registerTool(
    {
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters,
      async execute(_toolCallId, params) {
        try {
          return await withFeishuToolClient({
            api,
            toolName: spec.name,
            run: async ({ client }) => json(await spec.run(client as BitableClient, params as P)),
          });
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    { name: spec.name },
  );
}

export function registerFeishuBitableTools(api: OpenClawPluginApi) {
  if (!api.config || !hasFeishuToolEnabledForAnyAccount(api.config)) {
    api.logger.debug?.("feishu_bitable: Feishu credentials not configured, skipping bitable tools");
    return;
  }

  // Bitable tools are globally registered once, but each execution resolves
  // the effective account through withFeishuToolClient().
  // Keep registration explicit and flat so each tool is easy to locate and modify.
  registerBitableTool<GetMetaParams>(api, {
    name: "feishu_bitable_get_meta",
    label: "Feishu Bitable Get Meta",
    description:
      "Parse a Bitable URL and get app_token, table_id, and table list. Use this first when given a /wiki/ or /base/ URL.",
    parameters: GetMetaSchema,
    run: (client, { url }) => getBitableMeta(client, url),
  });

  registerBitableTool<ListFieldsParams>(api, {
    name: "feishu_bitable_list_fields",
    label: "Feishu Bitable List Fields",
    description: "List all fields (columns) in a Bitable table with their types and properties",
    parameters: ListFieldsSchema,
    run: (client, { app_token, table_id }) => listFields(client, app_token, table_id),
  });

  registerBitableTool<ListRecordsParams>(api, {
    name: "feishu_bitable_list_records",
    label: "Feishu Bitable List Records",
    description: "List records (rows) from a Bitable table with pagination support",
    parameters: ListRecordsSchema,
    run: (client, { app_token, table_id, page_size, page_token }) =>
      listRecords(client, app_token, table_id, page_size, page_token),
  });

  registerBitableTool<CreateAppParams>(api, {
    name: "feishu_bitable_create_app",
    label: "Feishu Bitable Create App",
    description: "Create a new Bitable (multidimensional table) application",
    parameters: CreateAppSchema,
    run: (client, { name, folder_token }) =>
      createApp(client, name, folder_token, {
        debug: (msg) => api.logger.debug?.(msg),
        warn: (msg) => api.logger.warn?.(msg),
      }),
  });

  registerBitableTool<CreateFieldParams>(api, {
    name: "feishu_bitable_create_field",
    label: "Feishu Bitable Create Field",
    description: "Create a new field (column) in a Bitable table",
    parameters: CreateFieldSchema,
    run: (client, { app_token, table_id, field_name, type, property, description, ui_type }) =>
      createField(client, app_token, table_id, {
        field_name,
        type,
        property,
        description,
        ui_type,
      }),
  });

  registerBitableTool<UpdateFieldParams>(api, {
    name: "feishu_bitable_update_field",
    label: "Feishu Bitable Update Field",
    description: "Update an existing field (column) in a Bitable table",
    parameters: UpdateFieldSchema,
    run: (
      client,
      { app_token, table_id, field_id, field_name, type, property, description, ui_type },
    ) =>
      updateField(client, app_token, table_id, field_id, {
        field_name,
        type,
        property,
        description,
        ui_type,
      }),
  });

  registerBitableTool<DeleteFieldParams>(api, {
    name: "feishu_bitable_delete_field",
    label: "Feishu Bitable Delete Field",
    description: "Delete a field (column) from a Bitable table",
    parameters: DeleteFieldSchema,
    run: (client, { app_token, table_id, field_id }) =>
      deleteField(client, app_token, table_id, field_id),
  });

  registerBitableTool<GetRecordParams>(api, {
    name: "feishu_bitable_get_record",
    label: "Feishu Bitable Get Record",
    description: "Get a single record by ID from a Bitable table",
    parameters: GetRecordSchema,
    run: (client, { app_token, table_id, record_id }) =>
      getRecord(client, app_token, table_id, record_id),
  });

  registerBitableTool<CreateRecordParams>(api, {
    name: "feishu_bitable_create_record",
    label: "Feishu Bitable Create Record",
    description: "Create a new record (row) in a Bitable table",
    parameters: CreateRecordSchema,
    run: (client, { app_token, table_id, fields }) =>
      createRecord(client, app_token, table_id, fields as BitableRecordFields),
  });

  registerBitableTool<UpdateRecordParams>(api, {
    name: "feishu_bitable_update_record",
    label: "Feishu Bitable Update Record",
    description: "Update an existing record (row) in a Bitable table",
    parameters: UpdateRecordSchema,
    run: (client, { app_token, table_id, record_id, fields }) =>
      updateRecord(client, app_token, table_id, record_id, fields as BitableRecordFields),
  });

  registerBitableTool<DeleteRecordParams>(api, {
    name: "feishu_bitable_delete_record",
    label: "Feishu Bitable Delete Record",
    description: "Delete a single record (row) from a Bitable table",
    parameters: DeleteRecordSchema,
    run: (client, { app_token, table_id, record_id }) =>
      deleteRecord(client, app_token, table_id, record_id),
  });

  registerBitableTool<BatchDeleteRecordsParams>(api, {
    name: "feishu_bitable_batch_delete_records",
    label: "Feishu Bitable Batch Delete Records",
    description: "Delete multiple records (rows) from a Bitable table in one request",
    parameters: BatchDeleteRecordsSchema,
    run: (client, { app_token, table_id, record_ids }) =>
      batchDeleteRecords(client, app_token, table_id, record_ids),
  });

  api.logger.debug?.("feishu_bitable: Registered 12 bitable tools");
}
