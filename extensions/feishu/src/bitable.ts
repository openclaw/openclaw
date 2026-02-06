import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import type { FeishuConfig } from "./types.js";
import { createFeishuClient } from "./client.js";

// ============ Helpers ============

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

/** Field type ID to human-readable name */
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

// ============ Core Functions ============

/** Parse bitable URL and extract tokens */
function parseBitableUrl(url: string): { token: string; tableId?: string; isWiki: boolean } | null {
  try {
    const u = new URL(url);
    const tableId = u.searchParams.get("table") ?? undefined;

    // Wiki format: /wiki/XXXXX?table=YYY
    const wikiMatch = u.pathname.match(/\/wiki\/([A-Za-z0-9]+)/);
    if (wikiMatch) {
      return { token: wikiMatch[1], tableId, isWiki: true };
    }

    // Base format: /base/XXXXX?table=YYY
    const baseMatch = u.pathname.match(/\/base\/([A-Za-z0-9]+)/);
    if (baseMatch) {
      return { token: baseMatch[1], tableId, isWiki: false };
    }

    return null;
  } catch {
    return null;
  }
}

/** Get app_token from wiki node_token */
async function getAppTokenFromWiki(
  client: ReturnType<typeof createFeishuClient>,
  nodeToken: string,
): Promise<string> {
  const res = await client.wiki.space.getNode({
    params: { token: nodeToken },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const node = res.data?.node;
  if (!node) {
    throw new Error("Node not found");
  }
  if (node.obj_type !== "bitable") {
    throw new Error(`Node is not a bitable (type: ${node.obj_type})`);
  }

  return node.obj_token!;
}

/** Get bitable metadata from URL (handles both /base/ and /wiki/ URLs) */
async function getBitableMeta(client: ReturnType<typeof createFeishuClient>, url: string) {
  const parsed = parseBitableUrl(url);
  if (!parsed) {
    throw new Error("Invalid URL format. Expected /base/XXX or /wiki/XXX URL");
  }

  let appToken: string;
  if (parsed.isWiki) {
    appToken = await getAppTokenFromWiki(client, parsed.token);
  } else {
    appToken = parsed.token;
  }

  // Get bitable app info
  const res = await client.bitable.app.get({
    path: { app_token: appToken },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  // List tables if no table_id specified
  let tables: { table_id: string; name: string }[] = [];
  if (!parsed.tableId) {
    const tablesRes = await client.bitable.appTable.list({
      path: { app_token: appToken },
    });
    if (tablesRes.code === 0) {
      tables = (tablesRes.data?.items ?? []).map((t) => ({
        table_id: t.table_id!,
        name: t.name!,
      }));
    }
  }

  return {
    app_token: appToken,
    table_id: parsed.tableId,
    name: res.data?.app?.name,
    url_type: parsed.isWiki ? "wiki" : "base",
    ...(tables.length > 0 && { tables }),
    hint: parsed.tableId
      ? `Use app_token="${appToken}" and table_id="${parsed.tableId}" for other bitable tools`
      : `Use app_token="${appToken}" for other bitable tools. Select a table_id from the tables list.`,
  };
}

async function listFields(
  client: ReturnType<typeof createFeishuClient>,
  appToken: string,
  tableId: string,
) {
  const res = await client.bitable.appTableField.list({
    path: { app_token: appToken, table_id: tableId },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const fields = res.data?.items ?? [];
  return {
    fields: fields.map((f) => ({
      field_id: f.field_id,
      field_name: f.field_name,
      type: f.type,
      type_name: FIELD_TYPE_NAMES[f.type ?? 0] || `type_${f.type}`,
      is_primary: f.is_primary,
      ...(f.property && { property: f.property }),
    })),
    total: fields.length,
  };
}

async function listRecords(
  client: ReturnType<typeof createFeishuClient>,
  appToken: string,
  tableId: string,
  pageSize?: number,
  pageToken?: string,
) {
  const res = await client.bitable.appTableRecord.list({
    path: { app_token: appToken, table_id: tableId },
    params: {
      page_size: pageSize ?? 100,
      ...(pageToken && { page_token: pageToken }),
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    records: res.data?.items ?? [],
    has_more: res.data?.has_more ?? false,
    page_token: res.data?.page_token,
    total: res.data?.total,
  };
}

async function getRecord(
  client: ReturnType<typeof createFeishuClient>,
  appToken: string,
  tableId: string,
  recordId: string,
) {
  const res = await client.bitable.appTableRecord.get({
    path: { app_token: appToken, table_id: tableId, record_id: recordId },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    record: res.data?.record,
  };
}

async function createRecord(
  client: ReturnType<typeof createFeishuClient>,
  appToken: string,
  tableId: string,
  fields: Record<string, unknown>,
) {
  const res = await client.bitable.appTableRecord.create({
    path: { app_token: appToken, table_id: tableId },
    data: { fields },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    record: res.data?.record,
  };
}

async function updateRecord(
  client: ReturnType<typeof createFeishuClient>,
  appToken: string,
  tableId: string,
  recordId: string,
  fields: Record<string, unknown>,
) {
  const res = await client.bitable.appTableRecord.update({
    path: { app_token: appToken, table_id: tableId, record_id: recordId },
    data: { fields },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    record: res.data?.record,
  };
}

// ============ Schemas ============

const GetMetaSchema = Type.Object({
  url: Type.String({
    description: "Bitable URL. Supports both formats: /base/XXX?table=YYY or /wiki/XXX?table=YYY",
  }),
});

const ListFieldsSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
});

const ListRecordsSchema = Type.Object({
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

const GetRecordSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
  record_id: Type.String({ description: "Record ID to retrieve" }),
});

const CreateRecordSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
  fields: Type.Record(Type.String(), Type.Any(), {
    description:
      "Field values keyed by field name. Format by type: Text='string', Number=123, SingleSelect='Option', MultiSelect=['A','B'], DateTime=timestamp_ms, User=[{id:'ou_xxx'}], URL={text:'Display',link:'https://...'}",
  }),
});

const UpdateRecordSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
  record_id: Type.String({ description: "Record ID to update" }),
  fields: Type.Record(Type.String(), Type.Any(), {
    description: "Field values to update (same format as create_record)",
  }),
});

// ============ Tool Registration ============

export function registerFeishuBitableTools(api: OpenClawPluginApi) {
  const feishuCfg = api.config?.channels?.feishu as FeishuConfig | undefined;
  if (!feishuCfg?.appId || !feishuCfg?.appSecret) {
    api.logger.debug?.("feishu_bitable: Feishu credentials not configured, skipping bitable tools");
    return;
  }

  const getClient = () => createFeishuClient(feishuCfg);

  // Tool 0: feishu_bitable_get_meta (helper to parse URLs)
  api.registerTool(
    {
      name: "feishu_bitable_get_meta",
      label: "Feishu Bitable Get Meta",
      description:
        "Parse a Bitable URL and get app_token, table_id, and table list. Use this first when given a /wiki/ or /base/ URL.",
      parameters: GetMetaSchema,
      async execute(_toolCallId, params) {
        const { url } = params as { url: string };
        try {
          const result = await getBitableMeta(getClient(), url);
          return json(result);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_bitable_get_meta" },
  );

  // Tool 1: feishu_bitable_list_fields
  api.registerTool(
    {
      name: "feishu_bitable_list_fields",
      label: "Feishu Bitable List Fields",
      description: "List all fields (columns) in a Bitable table with their types and properties",
      parameters: ListFieldsSchema,
      async execute(_toolCallId, params) {
        const { app_token, table_id } = params as { app_token: string; table_id: string };
        try {
          const result = await listFields(getClient(), app_token, table_id);
          return json(result);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_bitable_list_fields" },
  );

  // Tool 2: feishu_bitable_list_records
  api.registerTool(
    {
      name: "feishu_bitable_list_records",
      label: "Feishu Bitable List Records",
      description: "List records (rows) from a Bitable table with pagination support",
      parameters: ListRecordsSchema,
      async execute(_toolCallId, params) {
        const { app_token, table_id, page_size, page_token } = params as {
          app_token: string;
          table_id: string;
          page_size?: number;
          page_token?: string;
        };
        try {
          const result = await listRecords(getClient(), app_token, table_id, page_size, page_token);
          return json(result);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_bitable_list_records" },
  );

  // Tool 3: feishu_bitable_get_record
  api.registerTool(
    {
      name: "feishu_bitable_get_record",
      label: "Feishu Bitable Get Record",
      description: "Get a single record by ID from a Bitable table",
      parameters: GetRecordSchema,
      async execute(_toolCallId, params) {
        const { app_token, table_id, record_id } = params as {
          app_token: string;
          table_id: string;
          record_id: string;
        };
        try {
          const result = await getRecord(getClient(), app_token, table_id, record_id);
          return json(result);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_bitable_get_record" },
  );

  // Tool 4: feishu_bitable_create_record
  api.registerTool(
    {
      name: "feishu_bitable_create_record",
      label: "Feishu Bitable Create Record",
      description: "Create a new record (row) in a Bitable table",
      parameters: CreateRecordSchema,
      async execute(_toolCallId, params) {
        const { app_token, table_id, fields } = params as {
          app_token: string;
          table_id: string;
          fields: Record<string, unknown>;
        };
        try {
          const result = await createRecord(getClient(), app_token, table_id, fields);
          return json(result);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_bitable_create_record" },
  );

  // Tool 5: feishu_bitable_update_record
  api.registerTool(
    {
      name: "feishu_bitable_update_record",
      label: "Feishu Bitable Update Record",
      description: "Update an existing record (row) in a Bitable table",
      parameters: UpdateRecordSchema,
      async execute(_toolCallId, params) {
        const { app_token, table_id, record_id, fields } = params as {
          app_token: string;
          table_id: string;
          record_id: string;
          fields: Record<string, unknown>;
        };
        try {
          const result = await updateRecord(getClient(), app_token, table_id, record_id, fields);
          return json(result);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_bitable_update_record" },
  );

  api.logger.info?.(`feishu_bitable: Registered 6 bitable tools`);
}
