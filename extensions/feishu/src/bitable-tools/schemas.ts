import { Type } from "@sinclair/typebox";
import type {
  BitableAppCreateData,
  BitableFieldCreateData,
  BitableFieldDescription,
  BitableFieldUpdateData,
} from "./common.js";

export type GetMetaParams = {
  url: string;
};

export type ListFieldsParams = {
  app_token: string;
  table_id: string;
};

export type CreateFieldParams = {
  app_token: string;
  table_id: string;
  field_name: BitableFieldCreateData["field_name"];
  type: BitableFieldCreateData["type"];
  property?: BitableFieldCreateData["property"];
  description?: BitableFieldDescription;
  ui_type?: BitableFieldCreateData["ui_type"];
};

export type UpdateFieldParams = {
  app_token: string;
  table_id: string;
  field_id: string;
  field_name: BitableFieldUpdateData["field_name"];
  type: BitableFieldUpdateData["type"];
  property?: BitableFieldUpdateData["property"];
  description?: BitableFieldDescription;
  ui_type?: BitableFieldUpdateData["ui_type"];
};

export type DeleteFieldParams = {
  app_token: string;
  table_id: string;
  field_id: string;
};

export type ListRecordsParams = {
  app_token: string;
  table_id: string;
  page_size?: number;
  page_token?: string;
};

export type GetRecordParams = {
  app_token: string;
  table_id: string;
  record_id: string;
};

export type CreateRecordParams = {
  app_token: string;
  table_id: string;
  fields: Record<string, unknown>;
};

export type CreateAppParams = {
  name: BitableAppCreateData["name"];
  folder_token?: BitableAppCreateData["folder_token"];
};

export type UpdateRecordParams = {
  app_token: string;
  table_id: string;
  record_id: string;
  fields: Record<string, unknown>;
};

export type DeleteRecordParams = {
  app_token: string;
  table_id: string;
  record_id: string;
};

export type BatchDeleteRecordsParams = {
  app_token: string;
  table_id: string;
  record_ids: string[];
};

export const GetMetaSchema = Type.Object({
  url: Type.String({
    description: "Bitable URL. Supports both formats: /base/XXX?table=YYY or /wiki/XXX?table=YYY",
  }),
});

export const ListFieldsSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
});

export const CreateFieldSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
  field_name: Type.String({ description: "Field name" }),
  type: Type.Number({
    description: "Field type ID (e.g., 1=Text, 2=Number, 3=SingleSelect, 4=MultiSelect)",
  }),
  property: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description:
        "Optional field property object, pass-through to Feishu API (e.g., select options/date format)",
    }),
  ),
  description: Type.Optional(
    Type.Object(
      {
        disable_sync: Type.Optional(Type.Boolean()),
        text: Type.Optional(Type.String()),
      },
      { description: "Optional field description metadata" },
    ),
  ),
  ui_type: Type.Optional(
    Type.String({ description: "Optional UI type override (e.g., Text, Number, SingleSelect)" }),
  ),
});

export const UpdateFieldSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
  field_id: Type.String({ description: "Field ID to update" }),
  field_name: Type.String({ description: "Updated field name" }),
  type: Type.Number({ description: "Updated field type ID" }),
  property: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description: "Optional field property object, pass-through to Feishu API",
    }),
  ),
  description: Type.Optional(
    Type.Object(
      {
        disable_sync: Type.Optional(Type.Boolean()),
        text: Type.Optional(Type.String()),
      },
      { description: "Optional field description metadata" },
    ),
  ),
  ui_type: Type.Optional(Type.String({ description: "Optional UI type override" })),
});

export const DeleteFieldSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
  field_id: Type.String({ description: "Field ID to delete" }),
});

export const ListRecordsSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
  page_size: Type.Optional(
    Type.Number({
      description: "Number of records per page (1-500, default 100)",
      minimum: 1,
      maximum: 500,
    }),
  ),
  page_token: Type.Optional(
    Type.String({ description: "Pagination token from previous response" }),
  ),
});

export const GetRecordSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
  record_id: Type.String({ description: "Record ID to retrieve" }),
});

export const CreateRecordSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
  fields: Type.Record(Type.String(), Type.Any(), {
    description:
      "Field values keyed by field name. Format by type: Text='string', Number=123, SingleSelect='Option', MultiSelect=['A','B'], DateTime=timestamp_ms, User=[{id:'ou_xxx'}], URL={text:'Display',link:'https://...'}",
  }),
});

export const CreateAppSchema = Type.Object({
  name: Type.String({
    description: "Name for the new Bitable application",
  }),
  folder_token: Type.Optional(
    Type.String({
      description: "Optional folder token to place the Bitable in a specific folder",
    }),
  ),
});

export const UpdateRecordSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
  record_id: Type.String({ description: "Record ID to update" }),
  fields: Type.Record(Type.String(), Type.Any(), {
    description: "Field values to update (same format as create_record)",
  }),
});

export const DeleteRecordSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
  record_id: Type.String({ description: "Record ID to delete" }),
});

export const BatchDeleteRecordsSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
  record_ids: Type.Array(Type.String(), {
    description: "Record ID list to delete (max 500 per request)",
    minItems: 1,
    maxItems: 500,
  }),
});
