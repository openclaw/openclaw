import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../resolve-route-CQsiaDZO.js";
import "../../logger-BOdgfoqz.js";
import "../../tmp-openclaw-dir-DgEKZnX6.js";
import "../../paths-CbmqEZIn.js";
import "../../subsystem-CsPxmH8p.js";
import "../../utils-CMc9mmF8.js";
import "../../fetch-BgkAjqxB.js";
import "../../retry-CgLvWye-.js";
import "../../agent-scope-CM8plEdu.js";
import "../../exec-CWMR162-.js";
import "../../logger-C833gw0R.js";
import "../../paths-DAoqckDF.js";
import { Bo as resolveFeishuAccount, Lo as listEnabledFeishuAccounts, Mo as probeFeishu, Po as createFeishuClient, So as parseFeishuConversationId, xo as buildFeishuConversationId } from "../../auth-profiles-B70DPAVa.js";
import "../../profiles-BC4VpDll.js";
import "../../fetch-BX2RRCzB.js";
import "../../external-content-CxoN_TKD.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-gVOHvGnm.js";
import "../../pairing-token-Do-E3rL5.js";
import "../../query-expansion-Do6vyPvH.js";
import "../../redact-BZcL_gJG.js";
import "../../mime-33LCeGh-.js";
import "../../resolve-utils-D6VN4BvH.js";
import "../../typebox-B4kR5eyM.js";
import "../../web-search-plugin-factory-CeUlA68v.js";
import "../../compat-CwB8x8Tr.js";
import "../../inbound-envelope-DsYY1Vpm.js";
import "../../run-command-B9zmAfEF.js";
import "../../device-pairing-CsJif6Rb.js";
import "../../line-DvbTO_h3.js";
import "../../upsert-with-lock-BkGBN4WL.js";
import "../../self-hosted-provider-setup-Bgv4n1Xv.js";
import "../../ollama-setup-CXkNt6CA.js";
import { c as registerFeishuChatTools, i as removeReactionFeishu, l as resolveToolsConfig, n as addReactionFeishu, r as listReactionsFeishu, t as FeishuEmoji } from "../../reactions-BoefvOu_.js";
import { t as feishuPlugin } from "../../channel-CUCOxESZ.js";
import { i as normalizeFeishuTarget, n as setFeishuRuntime, t as getFeishuRuntime } from "../../runtime-XB3y4bUE.js";
import "../../directory.static-CI0691ej.js";
import "../../policy-CsBHeL2R.js";
import { r as getFeishuThreadBindingManager, t as monitorFeishuProvider } from "../../monitor-CBf3Acag.js";
import "../../persistent-bindings.route-B997Djeo.js";
import { C as sendMediaFeishu, S as sendImageFeishu, T as uploadImageFeishu, _ as formatMentionForCard, a as sendCardFeishu, d as buildMentionedCardContent, f as buildMentionedMessage, g as formatMentionAllForText, h as formatMentionAllForCard, l as updateCardFeishu, m as extractMessageBody, n as getMessageFeishu, p as extractMentionTargets, s as sendMessageFeishu, t as editMessageFeishu, v as formatMentionForText, w as uploadFileFeishu, x as sendFileFeishu, y as isMentionForwardRequest } from "../../send-tCWWXKu4.js";
import { existsSync, promises } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { Type } from "@sinclair/typebox";
//#region extensions/feishu/src/tool-account.ts
function normalizeOptionalAccountId(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
function readConfiguredDefaultAccountId(config) {
	const value = (config?.channels?.feishu)?.defaultAccount;
	if (typeof value !== "string") return;
	return normalizeOptionalAccountId(value);
}
function resolveFeishuToolAccount(params) {
	if (!params.api.config) throw new Error("Feishu config unavailable");
	return resolveFeishuAccount({
		cfg: params.api.config,
		accountId: normalizeOptionalAccountId(params.executeParams?.accountId) ?? readConfiguredDefaultAccountId(params.api.config) ?? normalizeOptionalAccountId(params.defaultAccountId)
	});
}
function createFeishuToolClient(params) {
	return createFeishuClient(resolveFeishuToolAccount(params));
}
function resolveAnyEnabledFeishuToolsConfig(accounts) {
	const merged = {
		doc: false,
		chat: false,
		wiki: false,
		drive: false,
		perm: false,
		scopes: false
	};
	for (const account of accounts) {
		const cfg = resolveToolsConfig(account.config.tools);
		merged.doc = merged.doc || cfg.doc;
		merged.chat = merged.chat || cfg.chat;
		merged.wiki = merged.wiki || cfg.wiki;
		merged.drive = merged.drive || cfg.drive;
		merged.perm = merged.perm || cfg.perm;
		merged.scopes = merged.scopes || cfg.scopes;
	}
	return merged;
}
//#endregion
//#region extensions/feishu/src/bitable.ts
function json$1(data) {
	return {
		content: [{
			type: "text",
			text: JSON.stringify(data, null, 2)
		}],
		details: data
	};
}
var LarkApiError = class extends Error {
	constructor(code, message, api, context) {
		super(`[${api}] code=${code} message=${message}`);
		this.name = "LarkApiError";
		this.code = code;
		this.api = api;
		this.context = context;
	}
};
function ensureLarkSuccess(res, api, context) {
	if (res.code !== 0) throw new LarkApiError(res.code ?? -1, res.msg ?? "unknown error", api, context);
}
/** Field type ID to human-readable name */
const FIELD_TYPE_NAMES = {
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
	1005: "AutoNumber"
};
/** Parse bitable URL and extract tokens */
function parseBitableUrl(url) {
	try {
		const u = new URL(url);
		const tableId = u.searchParams.get("table") ?? void 0;
		const wikiMatch = u.pathname.match(/\/wiki\/([A-Za-z0-9]+)/);
		if (wikiMatch) return {
			token: wikiMatch[1],
			tableId,
			isWiki: true
		};
		const baseMatch = u.pathname.match(/\/base\/([A-Za-z0-9]+)/);
		if (baseMatch) return {
			token: baseMatch[1],
			tableId,
			isWiki: false
		};
		return null;
	} catch {
		return null;
	}
}
/** Get app_token from wiki node_token */
async function getAppTokenFromWiki(client, nodeToken) {
	const res = await client.wiki.space.getNode({ params: { token: nodeToken } });
	ensureLarkSuccess(res, "wiki.space.getNode", { nodeToken });
	const node = res.data?.node;
	if (!node) throw new Error("Node not found");
	if (node.obj_type !== "bitable") throw new Error(`Node is not a bitable (type: ${node.obj_type})`);
	return node.obj_token;
}
/** Get bitable metadata from URL (handles both /base/ and /wiki/ URLs) */
async function getBitableMeta(client, url) {
	const parsed = parseBitableUrl(url);
	if (!parsed) throw new Error("Invalid URL format. Expected /base/XXX or /wiki/XXX URL");
	let appToken;
	if (parsed.isWiki) appToken = await getAppTokenFromWiki(client, parsed.token);
	else appToken = parsed.token;
	const res = await client.bitable.app.get({ path: { app_token: appToken } });
	ensureLarkSuccess(res, "bitable.app.get", { appToken });
	let tables = [];
	if (!parsed.tableId) {
		const tablesRes = await client.bitable.appTable.list({ path: { app_token: appToken } });
		if (tablesRes.code === 0) tables = (tablesRes.data?.items ?? []).map((t) => ({
			table_id: t.table_id,
			name: t.name
		}));
	}
	return {
		app_token: appToken,
		table_id: parsed.tableId,
		name: res.data?.app?.name,
		url_type: parsed.isWiki ? "wiki" : "base",
		...tables.length > 0 && { tables },
		hint: parsed.tableId ? `Use app_token="${appToken}" and table_id="${parsed.tableId}" for other bitable tools` : `Use app_token="${appToken}" for other bitable tools. Select a table_id from the tables list.`
	};
}
async function listFields(client, appToken, tableId) {
	const res = await client.bitable.appTableField.list({ path: {
		app_token: appToken,
		table_id: tableId
	} });
	ensureLarkSuccess(res, "bitable.appTableField.list", {
		appToken,
		tableId
	});
	const fields = res.data?.items ?? [];
	return {
		fields: fields.map((f) => ({
			field_id: f.field_id,
			field_name: f.field_name,
			type: f.type,
			type_name: FIELD_TYPE_NAMES[f.type ?? 0] || `type_${f.type}`,
			is_primary: f.is_primary,
			...f.property && { property: f.property }
		})),
		total: fields.length
	};
}
async function listRecords(client, appToken, tableId, pageSize, pageToken) {
	const res = await client.bitable.appTableRecord.list({
		path: {
			app_token: appToken,
			table_id: tableId
		},
		params: {
			page_size: pageSize ?? 100,
			...pageToken && { page_token: pageToken }
		}
	});
	ensureLarkSuccess(res, "bitable.appTableRecord.list", {
		appToken,
		tableId,
		pageSize
	});
	return {
		records: res.data?.items ?? [],
		has_more: res.data?.has_more ?? false,
		page_token: res.data?.page_token,
		total: res.data?.total
	};
}
async function getRecord(client, appToken, tableId, recordId) {
	const res = await client.bitable.appTableRecord.get({ path: {
		app_token: appToken,
		table_id: tableId,
		record_id: recordId
	} });
	ensureLarkSuccess(res, "bitable.appTableRecord.get", {
		appToken,
		tableId,
		recordId
	});
	return { record: res.data?.record };
}
async function createRecord(client, appToken, tableId, fields) {
	const res = await client.bitable.appTableRecord.create({
		path: {
			app_token: appToken,
			table_id: tableId
		},
		data: { fields }
	});
	ensureLarkSuccess(res, "bitable.appTableRecord.create", {
		appToken,
		tableId
	});
	return { record: res.data?.record };
}
/** Default field types created for new Bitable tables (to be cleaned up) */
const DEFAULT_CLEANUP_FIELD_TYPES = new Set([
	3,
	5,
	17
]);
/** Clean up default placeholder rows and fields in a newly created Bitable table */
async function cleanupNewBitable(client, appToken, tableId, tableName, logger) {
	let cleanedRows = 0;
	let cleanedFields = 0;
	const fieldsRes = await client.bitable.appTableField.list({ path: {
		app_token: appToken,
		table_id: tableId
	} });
	if (fieldsRes.code === 0 && fieldsRes.data?.items) {
		const primaryField = fieldsRes.data.items.find((f) => f.is_primary);
		if (primaryField?.field_id) try {
			const newFieldName = tableName.length <= 20 ? tableName : "Name";
			await client.bitable.appTableField.update({
				path: {
					app_token: appToken,
					table_id: tableId,
					field_id: primaryField.field_id
				},
				data: {
					field_name: newFieldName,
					type: 1
				}
			});
			cleanedFields++;
		} catch (err) {
			logger.debug(`Failed to rename primary field: ${err}`);
		}
		const defaultFieldsToDelete = fieldsRes.data.items.filter((f) => !f.is_primary && DEFAULT_CLEANUP_FIELD_TYPES.has(f.type ?? 0));
		for (const field of defaultFieldsToDelete) if (field.field_id) try {
			await client.bitable.appTableField.delete({ path: {
				app_token: appToken,
				table_id: tableId,
				field_id: field.field_id
			} });
			cleanedFields++;
		} catch (err) {
			logger.debug(`Failed to delete default field ${field.field_name}: ${err}`);
		}
	}
	const recordsRes = await client.bitable.appTableRecord.list({
		path: {
			app_token: appToken,
			table_id: tableId
		},
		params: { page_size: 100 }
	});
	if (recordsRes.code === 0 && recordsRes.data?.items) {
		const emptyRecordIds = recordsRes.data.items.filter((r) => !r.fields || Object.keys(r.fields).length === 0).map((r) => r.record_id).filter((id) => Boolean(id));
		if (emptyRecordIds.length > 0) try {
			await client.bitable.appTableRecord.batchDelete({
				path: {
					app_token: appToken,
					table_id: tableId
				},
				data: { records: emptyRecordIds }
			});
			cleanedRows = emptyRecordIds.length;
		} catch {
			for (const recordId of emptyRecordIds) try {
				await client.bitable.appTableRecord.delete({ path: {
					app_token: appToken,
					table_id: tableId,
					record_id: recordId
				} });
				cleanedRows++;
			} catch (err) {
				logger.debug(`Failed to delete empty row ${recordId}: ${err}`);
			}
		}
	}
	return {
		cleanedRows,
		cleanedFields
	};
}
async function createApp(client, name, folderToken, logger) {
	const res = await client.bitable.app.create({ data: {
		name,
		...folderToken && { folder_token: folderToken }
	} });
	ensureLarkSuccess(res, "bitable.app.create", {
		name,
		folderToken
	});
	const appToken = res.data?.app?.app_token;
	if (!appToken) throw new Error("Failed to create Bitable: no app_token returned");
	const log = logger ?? {
		debug: () => {},
		warn: () => {}
	};
	let tableId;
	let cleanedRows = 0;
	let cleanedFields = 0;
	try {
		const tablesRes = await client.bitable.appTable.list({ path: { app_token: appToken } });
		if (tablesRes.code === 0 && tablesRes.data?.items && tablesRes.data.items.length > 0) {
			tableId = tablesRes.data.items[0].table_id ?? void 0;
			if (tableId) {
				const cleanup = await cleanupNewBitable(client, appToken, tableId, name, log);
				cleanedRows = cleanup.cleanedRows;
				cleanedFields = cleanup.cleanedFields;
			}
		}
	} catch (err) {
		log.debug(`Cleanup failed (non-critical): ${err}`);
	}
	return {
		app_token: appToken,
		table_id: tableId,
		name: res.data?.app?.name,
		url: res.data?.app?.url,
		cleaned_placeholder_rows: cleanedRows,
		cleaned_default_fields: cleanedFields,
		hint: tableId ? `Table created. Use app_token="${appToken}" and table_id="${tableId}" for other bitable tools.` : "Table created. Use feishu_bitable_get_meta to get table_id and field details."
	};
}
async function createField(client, appToken, tableId, fieldName, fieldType, property) {
	const res = await client.bitable.appTableField.create({
		path: {
			app_token: appToken,
			table_id: tableId
		},
		data: {
			field_name: fieldName,
			type: fieldType,
			...property && { property }
		}
	});
	ensureLarkSuccess(res, "bitable.appTableField.create", {
		appToken,
		tableId,
		fieldName,
		fieldType
	});
	return {
		field_id: res.data?.field?.field_id,
		field_name: res.data?.field?.field_name,
		type: res.data?.field?.type,
		type_name: FIELD_TYPE_NAMES[res.data?.field?.type ?? 0] || `type_${res.data?.field?.type}`
	};
}
async function updateRecord(client, appToken, tableId, recordId, fields) {
	const res = await client.bitable.appTableRecord.update({
		path: {
			app_token: appToken,
			table_id: tableId,
			record_id: recordId
		},
		data: { fields }
	});
	ensureLarkSuccess(res, "bitable.appTableRecord.update", {
		appToken,
		tableId,
		recordId
	});
	return { record: res.data?.record };
}
const GetMetaSchema = Type.Object({ url: Type.String({ description: "Bitable URL. Supports both formats: /base/XXX?table=YYY or /wiki/XXX?table=YYY" }) });
const ListFieldsSchema = Type.Object({
	app_token: Type.String({ description: "Bitable app token (use feishu_bitable_get_meta to get from URL)" }),
	table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" })
});
const ListRecordsSchema = Type.Object({
	app_token: Type.String({ description: "Bitable app token (use feishu_bitable_get_meta to get from URL)" }),
	table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
	page_size: Type.Optional(Type.Number({
		description: "Number of records per page (1-500, default 100)",
		minimum: 1,
		maximum: 500
	})),
	page_token: Type.Optional(Type.String({ description: "Pagination token from previous response" }))
});
const GetRecordSchema = Type.Object({
	app_token: Type.String({ description: "Bitable app token (use feishu_bitable_get_meta to get from URL)" }),
	table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
	record_id: Type.String({ description: "Record ID to retrieve" })
});
const CreateRecordSchema = Type.Object({
	app_token: Type.String({ description: "Bitable app token (use feishu_bitable_get_meta to get from URL)" }),
	table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
	fields: Type.Record(Type.String(), Type.Any(), { description: "Field values keyed by field name. Format by type: Text='string', Number=123, SingleSelect='Option', MultiSelect=['A','B'], DateTime=timestamp_ms, User=[{id:'ou_xxx'}], URL={text:'Display',link:'https://...'}" })
});
const CreateAppSchema = Type.Object({
	name: Type.String({ description: "Name for the new Bitable application" }),
	folder_token: Type.Optional(Type.String({ description: "Optional folder token to place the Bitable in a specific folder" }))
});
const CreateFieldSchema = Type.Object({
	app_token: Type.String({ description: "Bitable app token (use feishu_bitable_get_meta to get from URL, or feishu_bitable_create_app to create new)" }),
	table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
	field_name: Type.String({ description: "Name for the new field" }),
	field_type: Type.Number({
		description: "Field type ID: 1=Text, 2=Number, 3=SingleSelect, 4=MultiSelect, 5=DateTime, 7=Checkbox, 11=User, 13=Phone, 15=URL, 17=Attachment, 18=SingleLink, 19=Lookup, 20=Formula, 21=DuplexLink, 22=Location, 23=GroupChat, 1001=CreatedTime, 1002=ModifiedTime, 1003=CreatedUser, 1004=ModifiedUser, 1005=AutoNumber",
		minimum: 1
	}),
	property: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Field-specific properties (e.g., options for SingleSelect, format for Number)" }))
});
const UpdateRecordSchema = Type.Object({
	app_token: Type.String({ description: "Bitable app token (use feishu_bitable_get_meta to get from URL)" }),
	table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
	record_id: Type.String({ description: "Record ID to update" }),
	fields: Type.Record(Type.String(), Type.Any(), { description: "Field values to update (same format as create_record)" })
});
function registerFeishuBitableTools(api) {
	if (!api.config) {
		api.logger.debug?.("feishu_bitable: No config available, skipping bitable tools");
		return;
	}
	if (listEnabledFeishuAccounts(api.config).length === 0) {
		api.logger.debug?.("feishu_bitable: No Feishu accounts configured, skipping bitable tools");
		return;
	}
	const getClient = (params, defaultAccountId) => createFeishuToolClient({
		api,
		executeParams: params,
		defaultAccountId
	});
	const registerBitableTool = (params) => {
		api.registerTool((ctx) => ({
			name: params.name,
			label: params.label,
			description: params.description,
			parameters: params.parameters,
			async execute(_toolCallId, rawParams) {
				try {
					return json$1(await params.execute({
						params: rawParams,
						defaultAccountId: ctx.agentAccountId
					}));
				} catch (err) {
					return json$1({ error: err instanceof Error ? err.message : String(err) });
				}
			}
		}), { name: params.name });
	};
	registerBitableTool({
		name: "feishu_bitable_get_meta",
		label: "Feishu Bitable Get Meta",
		description: "Parse a Bitable URL and get app_token, table_id, and table list. Use this first when given a /wiki/ or /base/ URL.",
		parameters: GetMetaSchema,
		async execute({ params, defaultAccountId }) {
			return getBitableMeta(getClient(params, defaultAccountId), params.url);
		}
	});
	registerBitableTool({
		name: "feishu_bitable_list_fields",
		label: "Feishu Bitable List Fields",
		description: "List all fields (columns) in a Bitable table with their types and properties",
		parameters: ListFieldsSchema,
		async execute({ params, defaultAccountId }) {
			return listFields(getClient(params, defaultAccountId), params.app_token, params.table_id);
		}
	});
	registerBitableTool({
		name: "feishu_bitable_list_records",
		label: "Feishu Bitable List Records",
		description: "List records (rows) from a Bitable table with pagination support",
		parameters: ListRecordsSchema,
		async execute({ params, defaultAccountId }) {
			return listRecords(getClient(params, defaultAccountId), params.app_token, params.table_id, params.page_size, params.page_token);
		}
	});
	registerBitableTool({
		name: "feishu_bitable_get_record",
		label: "Feishu Bitable Get Record",
		description: "Get a single record by ID from a Bitable table",
		parameters: GetRecordSchema,
		async execute({ params, defaultAccountId }) {
			return getRecord(getClient(params, defaultAccountId), params.app_token, params.table_id, params.record_id);
		}
	});
	registerBitableTool({
		name: "feishu_bitable_create_record",
		label: "Feishu Bitable Create Record",
		description: "Create a new record (row) in a Bitable table",
		parameters: CreateRecordSchema,
		async execute({ params, defaultAccountId }) {
			return createRecord(getClient(params, defaultAccountId), params.app_token, params.table_id, params.fields);
		}
	});
	registerBitableTool({
		name: "feishu_bitable_update_record",
		label: "Feishu Bitable Update Record",
		description: "Update an existing record (row) in a Bitable table",
		parameters: UpdateRecordSchema,
		async execute({ params, defaultAccountId }) {
			return updateRecord(getClient(params, defaultAccountId), params.app_token, params.table_id, params.record_id, params.fields);
		}
	});
	registerBitableTool({
		name: "feishu_bitable_create_app",
		label: "Feishu Bitable Create App",
		description: "Create a new Bitable (multidimensional table) application",
		parameters: CreateAppSchema,
		async execute({ params, defaultAccountId }) {
			return createApp(getClient(params, defaultAccountId), params.name, params.folder_token, {
				debug: (msg) => api.logger.debug?.(msg),
				warn: (msg) => api.logger.warn?.(msg)
			});
		}
	});
	registerBitableTool({
		name: "feishu_bitable_create_field",
		label: "Feishu Bitable Create Field",
		description: "Create a new field (column) in a Bitable table",
		parameters: CreateFieldSchema,
		async execute({ params, defaultAccountId }) {
			return createField(getClient(params, defaultAccountId), params.app_token, params.table_id, params.field_name, params.field_type, params.property);
		}
	});
	api.logger.info?.("feishu_bitable: Registered bitable tools");
}
//#endregion
//#region extensions/feishu/src/doc-schema.ts
const tableCreationProperties = {
	doc_token: Type.String({ description: "Document token" }),
	parent_block_id: Type.Optional(Type.String({ description: "Parent block ID (default: document root)" })),
	row_size: Type.Integer({
		description: "Table row count",
		minimum: 1
	}),
	column_size: Type.Integer({
		description: "Table column count",
		minimum: 1
	}),
	column_width: Type.Optional(Type.Array(Type.Number({ minimum: 1 }), { description: "Column widths in px (length should match column_size)" }))
};
const FeishuDocSchema = Type.Union([
	Type.Object({
		action: Type.Literal("read"),
		doc_token: Type.String({ description: "Document token (extract from URL /docx/XXX)" })
	}),
	Type.Object({
		action: Type.Literal("write"),
		doc_token: Type.String({ description: "Document token" }),
		content: Type.String({ description: "Markdown content to write (replaces entire document content)" })
	}),
	Type.Object({
		action: Type.Literal("append"),
		doc_token: Type.String({ description: "Document token" }),
		content: Type.String({ description: "Markdown content to append to end of document" })
	}),
	Type.Object({
		action: Type.Literal("insert"),
		doc_token: Type.String({ description: "Document token" }),
		content: Type.String({ description: "Markdown content to insert" }),
		after_block_id: Type.String({ description: "Insert content after this block ID. Use list_blocks to find block IDs." })
	}),
	Type.Object({
		action: Type.Literal("create"),
		title: Type.String({ description: "Document title" }),
		folder_token: Type.Optional(Type.String({ description: "Target folder token (optional)" })),
		grant_to_requester: Type.Optional(Type.Boolean({ description: "Grant edit permission to the trusted requesting Feishu user from runtime context (default: true)." }))
	}),
	Type.Object({
		action: Type.Literal("list_blocks"),
		doc_token: Type.String({ description: "Document token" })
	}),
	Type.Object({
		action: Type.Literal("get_block"),
		doc_token: Type.String({ description: "Document token" }),
		block_id: Type.String({ description: "Block ID (from list_blocks)" })
	}),
	Type.Object({
		action: Type.Literal("update_block"),
		doc_token: Type.String({ description: "Document token" }),
		block_id: Type.String({ description: "Block ID (from list_blocks)" }),
		content: Type.String({ description: "New text content" })
	}),
	Type.Object({
		action: Type.Literal("delete_block"),
		doc_token: Type.String({ description: "Document token" }),
		block_id: Type.String({ description: "Block ID" })
	}),
	Type.Object({
		action: Type.Literal("create_table"),
		...tableCreationProperties
	}),
	Type.Object({
		action: Type.Literal("write_table_cells"),
		doc_token: Type.String({ description: "Document token" }),
		table_block_id: Type.String({ description: "Table block ID" }),
		values: Type.Array(Type.Array(Type.String()), {
			description: "2D matrix values[row][col] to write into table cells",
			minItems: 1
		})
	}),
	Type.Object({
		action: Type.Literal("create_table_with_values"),
		...tableCreationProperties,
		values: Type.Array(Type.Array(Type.String()), {
			description: "2D matrix values[row][col] to write into table cells",
			minItems: 1
		})
	}),
	Type.Object({
		action: Type.Literal("insert_table_row"),
		doc_token: Type.String({ description: "Document token" }),
		block_id: Type.String({ description: "Table block ID" }),
		row_index: Type.Optional(Type.Number({ description: "Row index to insert at (-1 for end, default: -1)" }))
	}),
	Type.Object({
		action: Type.Literal("insert_table_column"),
		doc_token: Type.String({ description: "Document token" }),
		block_id: Type.String({ description: "Table block ID" }),
		column_index: Type.Optional(Type.Number({ description: "Column index to insert at (-1 for end, default: -1)" }))
	}),
	Type.Object({
		action: Type.Literal("delete_table_rows"),
		doc_token: Type.String({ description: "Document token" }),
		block_id: Type.String({ description: "Table block ID" }),
		row_start: Type.Number({ description: "Start row index (0-based)" }),
		row_count: Type.Optional(Type.Number({ description: "Number of rows to delete (default: 1)" }))
	}),
	Type.Object({
		action: Type.Literal("delete_table_columns"),
		doc_token: Type.String({ description: "Document token" }),
		block_id: Type.String({ description: "Table block ID" }),
		column_start: Type.Number({ description: "Start column index (0-based)" }),
		column_count: Type.Optional(Type.Number({ description: "Number of columns to delete (default: 1)" }))
	}),
	Type.Object({
		action: Type.Literal("merge_table_cells"),
		doc_token: Type.String({ description: "Document token" }),
		block_id: Type.String({ description: "Table block ID" }),
		row_start: Type.Number({ description: "Start row index" }),
		row_end: Type.Number({ description: "End row index (exclusive)" }),
		column_start: Type.Number({ description: "Start column index" }),
		column_end: Type.Number({ description: "End column index (exclusive)" })
	}),
	Type.Object({
		action: Type.Literal("upload_image"),
		doc_token: Type.String({ description: "Document token" }),
		url: Type.Optional(Type.String({ description: "Remote image URL (http/https)" })),
		file_path: Type.Optional(Type.String({ description: "Local image file path" })),
		image: Type.Optional(Type.String({ description: "Image as data URI (data:image/png;base64,...) or plain base64 string. Use instead of url/file_path for DALL-E outputs, canvas screenshots, etc." })),
		parent_block_id: Type.Optional(Type.String({ description: "Parent block ID (default: document root)" })),
		filename: Type.Optional(Type.String({ description: "Optional filename override" })),
		index: Type.Optional(Type.Integer({
			minimum: 0,
			description: "Insert position (0-based index among siblings). Omit to append."
		}))
	}),
	Type.Object({
		action: Type.Literal("upload_file"),
		doc_token: Type.String({ description: "Document token" }),
		url: Type.Optional(Type.String({ description: "Remote file URL (http/https)" })),
		file_path: Type.Optional(Type.String({ description: "Local file path" })),
		parent_block_id: Type.Optional(Type.String({ description: "Parent block ID (default: document root)" })),
		filename: Type.Optional(Type.String({ description: "Optional filename override" }))
	}),
	Type.Object({
		action: Type.Literal("color_text"),
		doc_token: Type.String({ description: "Document token" }),
		block_id: Type.String({ description: "Text block ID to update" }),
		content: Type.String({ description: "Text with color markup. Tags: [red], [green], [blue], [orange], [yellow], [purple], [grey], [bold], [bg:yellow]. Example: \"Revenue [green]+15%[/green] YoY\"" })
	})
]);
//#endregion
//#region extensions/feishu/src/docx-table-ops.ts
const MIN_COLUMN_WIDTH = 50;
const MAX_COLUMN_WIDTH = 400;
const DEFAULT_TABLE_WIDTH = 730;
/**
* Calculate adaptive column widths based on cell content length.
*
* Algorithm:
* 1. For each column, find the max content length across all rows
* 2. Weight CJK characters as 2x width (they render wider)
* 3. Calculate proportional widths based on content length
* 4. Apply min/max constraints
* 5. Redistribute remaining space to fill total table width
*
* Total width is derived from the original column_width values returned
* by the Convert API, ensuring tables match Feishu's expected dimensions.
*
* @param blocks - Array of blocks from Convert API
* @param tableBlockId - The block_id of the table block
* @returns Array of column widths in pixels
*/
function calculateAdaptiveColumnWidths(blocks, tableBlockId) {
	const tableBlock = blocks.find((b) => b.block_id === tableBlockId && b.block_type === 31);
	if (!tableBlock?.table?.property) return [];
	const { row_size, column_size, column_width: originalWidths } = tableBlock.table.property;
	const totalWidth = originalWidths && originalWidths.length > 0 ? originalWidths.reduce((a, b) => a + b, 0) : DEFAULT_TABLE_WIDTH;
	const cellIds = tableBlock.children || [];
	const blockMap = /* @__PURE__ */ new Map();
	for (const block of blocks) blockMap.set(block.block_id, block);
	function getCellText(cellId) {
		const cell = blockMap.get(cellId);
		if (!cell?.children) return "";
		let text = "";
		const childIds = Array.isArray(cell.children) ? cell.children : [cell.children];
		for (const childId of childIds) {
			const child = blockMap.get(childId);
			if (child?.text?.elements) {
				for (const elem of child.text.elements) if (elem.text_run?.content) text += elem.text_run.content;
			}
		}
		return text;
	}
	function getWeightedLength(text) {
		return [...text].reduce((sum, char) => {
			return sum + (char.charCodeAt(0) > 255 ? 2 : 1);
		}, 0);
	}
	const maxLengths = new Array(column_size).fill(0);
	for (let row = 0; row < row_size; row++) for (let col = 0; col < column_size; col++) {
		const cellId = cellIds[row * column_size + col];
		if (cellId) {
			const length = getWeightedLength(getCellText(cellId));
			maxLengths[col] = Math.max(maxLengths[col], length);
		}
	}
	const totalLength = maxLengths.reduce((a, b) => a + b, 0);
	if (totalLength === 0) {
		const equalWidth = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.floor(totalWidth / column_size)));
		return new Array(column_size).fill(equalWidth);
	}
	let widths = maxLengths.map((len) => {
		const proportion = len / totalLength;
		return Math.round(proportion * totalWidth);
	});
	widths = widths.map((w) => Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, w)));
	let remaining = totalWidth - widths.reduce((a, b) => a + b, 0);
	while (remaining > 0) {
		const growable = widths.map((w, i) => w < MAX_COLUMN_WIDTH ? i : -1).filter((i) => i >= 0);
		if (growable.length === 0) break;
		const perColumn = Math.floor(remaining / growable.length);
		if (perColumn === 0) break;
		for (const i of growable) {
			const add = Math.min(perColumn, MAX_COLUMN_WIDTH - widths[i]);
			widths[i] += add;
			remaining -= add;
		}
	}
	return widths;
}
/**
* Clean blocks for Descendant API with adaptive column widths.
*
* - Removes parent_id from all blocks
* - Fixes children type (string → array) for TableCell blocks
* - Removes merge_info (read-only, causes API error)
* - Calculates and applies adaptive column_width for tables
*
* @param blocks - Array of blocks from Convert API
* @returns Cleaned blocks ready for Descendant API
*/
function cleanBlocksForDescendant(blocks) {
	const tableWidths = /* @__PURE__ */ new Map();
	for (const block of blocks) if (block.block_type === 31) {
		const widths = calculateAdaptiveColumnWidths(blocks, block.block_id);
		tableWidths.set(block.block_id, widths);
	}
	return blocks.map((block) => {
		const { parent_id: _parentId, ...cleanBlock } = block;
		if (cleanBlock.block_type === 32 && typeof cleanBlock.children === "string") cleanBlock.children = [cleanBlock.children];
		if (cleanBlock.block_type === 31 && cleanBlock.table) {
			const { cells: _cells, ...tableWithoutCells } = cleanBlock.table;
			const { row_size, column_size } = tableWithoutCells.property || {};
			const adaptiveWidths = tableWidths.get(block.block_id);
			cleanBlock.table = { property: {
				row_size,
				column_size,
				...adaptiveWidths?.length && { column_width: adaptiveWidths }
			} };
		}
		return cleanBlock;
	});
}
async function insertTableRow(client, docToken, blockId, rowIndex = -1) {
	const res = await client.docx.documentBlock.patch({
		path: {
			document_id: docToken,
			block_id: blockId
		},
		data: { insert_table_row: { row_index: rowIndex } }
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		success: true,
		block: res.data?.block
	};
}
async function insertTableColumn(client, docToken, blockId, columnIndex = -1) {
	const res = await client.docx.documentBlock.patch({
		path: {
			document_id: docToken,
			block_id: blockId
		},
		data: { insert_table_column: { column_index: columnIndex } }
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		success: true,
		block: res.data?.block
	};
}
async function deleteTableRows(client, docToken, blockId, rowStart, rowCount = 1) {
	const res = await client.docx.documentBlock.patch({
		path: {
			document_id: docToken,
			block_id: blockId
		},
		data: { delete_table_rows: {
			row_start_index: rowStart,
			row_end_index: rowStart + rowCount
		} }
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		success: true,
		rows_deleted: rowCount,
		block: res.data?.block
	};
}
async function deleteTableColumns(client, docToken, blockId, columnStart, columnCount = 1) {
	const res = await client.docx.documentBlock.patch({
		path: {
			document_id: docToken,
			block_id: blockId
		},
		data: { delete_table_columns: {
			column_start_index: columnStart,
			column_end_index: columnStart + columnCount
		} }
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		success: true,
		columns_deleted: columnCount,
		block: res.data?.block
	};
}
async function mergeTableCells(client, docToken, blockId, rowStart, rowEnd, columnStart, columnEnd) {
	const res = await client.docx.documentBlock.patch({
		path: {
			document_id: docToken,
			block_id: blockId
		},
		data: { merge_table_cells: {
			row_start_index: rowStart,
			row_end_index: rowEnd,
			column_start_index: columnStart,
			column_end_index: columnEnd
		} }
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		success: true,
		block: res.data?.block
	};
}
//#endregion
//#region extensions/feishu/src/docx-batch-insert.ts
const BATCH_SIZE = 1e3;
/**
* Collect all descendant blocks for a given first-level block ID.
* Recursively traverses the block tree to gather all children.
*/
function collectDescendants(blockMap, rootId) {
	const result = [];
	const visited = /* @__PURE__ */ new Set();
	function collect(blockId) {
		if (visited.has(blockId)) return;
		visited.add(blockId);
		const block = blockMap.get(blockId);
		if (!block) return;
		result.push(block);
		const children = block.children;
		if (Array.isArray(children)) for (const childId of children) collect(childId);
		else if (typeof children === "string") collect(children);
	}
	collect(rootId);
	return result;
}
/**
* Insert a single batch of blocks using Descendant API.
*
* @param parentBlockId - Parent block to insert into (defaults to docToken)
* @param index - Position within parent's children (-1 = end)
*/
async function insertBatch(client, docToken, blocks, firstLevelBlockIds, parentBlockId = docToken, index = -1) {
	const descendants = cleanBlocksForDescendant(blocks);
	if (descendants.length === 0) return [];
	const res = await client.docx.documentBlockDescendant.create({
		path: {
			document_id: docToken,
			block_id: parentBlockId
		},
		data: {
			children_id: firstLevelBlockIds,
			descendants,
			index
		}
	});
	if (res.code !== 0) throw new Error(`${res.msg} (code: ${res.code})`);
	return res.data?.children ?? [];
}
/**
* Insert blocks in batches for large documents (>1000 blocks).
*
* Batches are split to ensure BOTH children_id AND descendants
* arrays stay under the 1000 block API limit.
*
* @param client - Feishu API client
* @param docToken - Document ID
* @param blocks - All blocks from Convert API
* @param firstLevelBlockIds - IDs of top-level blocks to insert
* @param logger - Optional logger for progress updates
* @param parentBlockId - Parent block to insert into (defaults to docToken = document root)
* @param startIndex - Starting position within parent (-1 = end). For multi-batch inserts,
*   each batch advances this by the number of first-level IDs inserted so far.
* @returns Inserted children blocks and any skipped block IDs
*/
async function insertBlocksInBatches(client, docToken, blocks, firstLevelBlockIds, logger, parentBlockId = docToken, startIndex = -1) {
	const allChildren = [];
	const batches = [];
	let currentBatch = {
		firstLevelIds: [],
		blocks: []
	};
	const usedBlockIds = /* @__PURE__ */ new Set();
	const blockMap = /* @__PURE__ */ new Map();
	for (const block of blocks) blockMap.set(block.block_id, block);
	for (const firstLevelId of firstLevelBlockIds) {
		const newBlocks = collectDescendants(blockMap, firstLevelId).filter((b) => !usedBlockIds.has(b.block_id));
		if (newBlocks.length > 1e3) throw new Error(`Block "${firstLevelId}" has ${newBlocks.length} descendants, which exceeds the Feishu API limit of ${BATCH_SIZE} blocks per request. Please split the content into smaller sections.`);
		if (currentBatch.blocks.length + newBlocks.length > 1e3 && currentBatch.blocks.length > 0) {
			batches.push(currentBatch);
			currentBatch = {
				firstLevelIds: [],
				blocks: []
			};
		}
		currentBatch.firstLevelIds.push(firstLevelId);
		for (const block of newBlocks) {
			currentBatch.blocks.push(block);
			usedBlockIds.add(block.block_id);
		}
	}
	if (currentBatch.blocks.length > 0) batches.push(currentBatch);
	let currentIndex = startIndex;
	for (let i = 0; i < batches.length; i++) {
		const batch = batches[i];
		logger?.info?.(`feishu_doc: Inserting batch ${i + 1}/${batches.length} (${batch.blocks.length} blocks)...`);
		const children = await insertBatch(client, docToken, batch.blocks, batch.firstLevelIds, parentBlockId, currentIndex);
		allChildren.push(...children);
		if (currentIndex !== -1) currentIndex += batch.firstLevelIds.length;
	}
	return {
		children: allChildren,
		skipped: []
	};
}
//#endregion
//#region extensions/feishu/src/docx-color-text.ts
const TEXT_COLOR = {
	red: 1,
	orange: 2,
	yellow: 3,
	green: 4,
	blue: 5,
	purple: 6,
	grey: 7,
	gray: 7
};
const BACKGROUND_COLOR = {
	red: 1,
	orange: 2,
	yellow: 3,
	green: 4,
	blue: 5,
	purple: 6,
	grey: 7,
	gray: 7
};
/**
* Parse color markup into segments.
*
* Supports:
*   [red]text[/red]               → red text
*   [bg:yellow]text[/bg]          → yellow background
*   [bold]text[/bold]             → bold
*   [green bold]text[/green]      → green + bold
*/
function parseColorMarkup(content) {
	const segments = [];
	const KNOWN = "(?:bg:[a-z]+|bold|red|orange|yellow|green|blue|purple|gr[ae]y)";
	const tagPattern = new RegExp(`\\[(${KNOWN}(?:\\s+${KNOWN})*)\\](.*?)\\[\\/(?:[^\\]]+)\\]|([^[]+|\\[)`, "gis");
	let match;
	while ((match = tagPattern.exec(content)) !== null) if (match[3] !== void 0) {
		if (match[3]) segments.push({ text: match[3] });
	} else {
		const tagStr = match[1].toLowerCase().trim();
		const text = match[2];
		const tags = tagStr.split(/\s+/);
		const segment = { text };
		for (const tag of tags) if (tag.startsWith("bg:")) {
			const color = tag.slice(3);
			if (BACKGROUND_COLOR[color]) segment.bgColor = BACKGROUND_COLOR[color];
		} else if (tag === "bold") segment.bold = true;
		else if (TEXT_COLOR[tag]) segment.textColor = TEXT_COLOR[tag];
		if (text) segments.push(segment);
	}
	return segments;
}
/**
* Update a text block with colored segments.
*/
async function updateColorText(client, docToken, blockId, content) {
	const segments = parseColorMarkup(content);
	const elements = segments.map((seg) => ({ text_run: {
		content: seg.text,
		text_element_style: {
			...seg.textColor && { text_color: seg.textColor },
			...seg.bgColor && { background_color: seg.bgColor },
			...seg.bold && { bold: true }
		}
	} }));
	const res = await client.docx.documentBlock.patch({
		path: {
			document_id: docToken,
			block_id: blockId
		},
		data: { update_text_elements: { elements } }
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		success: true,
		segments: segments.length,
		block: res.data?.block
	};
}
//#endregion
//#region extensions/feishu/src/docx.ts
function json(data) {
	return {
		content: [{
			type: "text",
			text: JSON.stringify(data, null, 2)
		}],
		details: data
	};
}
/** Extract image URLs from markdown content */
function extractImageUrls(markdown) {
	const regex = /!\[[^\]]*\]\(([^)]+)\)/g;
	const urls = [];
	let match;
	while ((match = regex.exec(markdown)) !== null) {
		const url = match[1].trim();
		if (url.startsWith("http://") || url.startsWith("https://")) urls.push(url);
	}
	return urls;
}
const BLOCK_TYPE_NAMES = {
	1: "Page",
	2: "Text",
	3: "Heading1",
	4: "Heading2",
	5: "Heading3",
	12: "Bullet",
	13: "Ordered",
	14: "Code",
	15: "Quote",
	17: "Todo",
	18: "Bitable",
	21: "Diagram",
	22: "Divider",
	23: "File",
	27: "Image",
	30: "Sheet",
	31: "Table",
	32: "TableCell"
};
const UNSUPPORTED_CREATE_TYPES = new Set([31, 32]);
/** Clean blocks for insertion (remove unsupported types and read-only fields) */
function cleanBlocksForInsert(blocks) {
	const skipped = [];
	return {
		cleaned: blocks.filter((block) => {
			if (UNSUPPORTED_CREATE_TYPES.has(block.block_type)) {
				const typeName = BLOCK_TYPE_NAMES[block.block_type] || `type_${block.block_type}`;
				skipped.push(typeName);
				return false;
			}
			return true;
		}).map((block) => {
			if (block.block_type === 31 && block.table?.merge_info) {
				const { merge_info: _merge_info, ...tableRest } = block.table;
				return {
					...block,
					table: tableRest
				};
			}
			return block;
		}),
		skipped
	};
}
const MAX_CONVERT_RETRY_DEPTH = 8;
async function convertMarkdown(client, markdown) {
	const res = await client.docx.document.convert({ data: {
		content_type: "markdown",
		content: markdown
	} });
	if (res.code !== 0) throw new Error(res.msg);
	return {
		blocks: res.data?.blocks ?? [],
		firstLevelBlockIds: res.data?.first_level_block_ids ?? []
	};
}
function sortBlocksByFirstLevel(blocks, firstLevelIds) {
	if (!firstLevelIds || firstLevelIds.length === 0) return blocks;
	const sorted = firstLevelIds.map((id) => blocks.find((b) => b.block_id === id)).filter(Boolean);
	const sortedIds = new Set(firstLevelIds);
	const remaining = blocks.filter((b) => !sortedIds.has(b.block_id));
	return [...sorted, ...remaining];
}
async function insertBlocks(client, docToken, blocks, parentBlockId, index) {
	const { cleaned, skipped } = cleanBlocksForInsert(blocks);
	const blockId = parentBlockId ?? docToken;
	if (cleaned.length === 0) return {
		children: [],
		skipped
	};
	const allInserted = [];
	for (const [offset, block] of cleaned.entries()) {
		const res = await client.docx.documentBlockChildren.create({
			path: {
				document_id: docToken,
				block_id: blockId
			},
			data: {
				children: [block],
				...index !== void 0 ? { index: index + offset } : {}
			}
		});
		if (res.code !== 0) throw new Error(res.msg);
		allInserted.push(...res.data?.children ?? []);
	}
	return {
		children: allInserted,
		skipped
	};
}
/** Split markdown into chunks at top-level headings (# or ##) to stay within API content limits */
function splitMarkdownByHeadings(markdown) {
	const lines = markdown.split("\n");
	const chunks = [];
	let current = [];
	let inFencedBlock = false;
	for (const line of lines) {
		if (/^(`{3,}|~{3,})/.test(line)) inFencedBlock = !inFencedBlock;
		if (!inFencedBlock && /^#{1,2}\s/.test(line) && current.length > 0) {
			chunks.push(current.join("\n"));
			current = [];
		}
		current.push(line);
	}
	if (current.length > 0) chunks.push(current.join("\n"));
	return chunks;
}
/** Split markdown by size, preferring to break outside fenced code blocks when possible */
function splitMarkdownBySize(markdown, maxChars) {
	if (markdown.length <= maxChars) return [markdown];
	const lines = markdown.split("\n");
	const chunks = [];
	let current = [];
	let currentLength = 0;
	let inFencedBlock = false;
	for (const line of lines) {
		if (/^(`{3,}|~{3,})/.test(line)) inFencedBlock = !inFencedBlock;
		const lineLength = line.length + 1;
		const wouldExceed = currentLength + lineLength > maxChars;
		if (current.length > 0 && wouldExceed && !inFencedBlock) {
			chunks.push(current.join("\n"));
			current = [];
			currentLength = 0;
		}
		current.push(line);
		currentLength += lineLength;
	}
	if (current.length > 0) chunks.push(current.join("\n"));
	if (chunks.length > 1) return chunks;
	const midpoint = Math.floor(lines.length / 2);
	if (midpoint <= 0 || midpoint >= lines.length) return [markdown];
	return [lines.slice(0, midpoint).join("\n"), lines.slice(midpoint).join("\n")];
}
async function convertMarkdownWithFallback(client, markdown, depth = 0) {
	try {
		return await convertMarkdown(client, markdown);
	} catch (error) {
		if (depth >= MAX_CONVERT_RETRY_DEPTH || markdown.length < 2) throw error;
		const chunks = splitMarkdownBySize(markdown, Math.max(256, Math.floor(markdown.length / 2)));
		if (chunks.length <= 1) throw error;
		const blocks = [];
		const firstLevelBlockIds = [];
		for (const chunk of chunks) {
			const converted = await convertMarkdownWithFallback(client, chunk, depth + 1);
			blocks.push(...converted.blocks);
			firstLevelBlockIds.push(...converted.firstLevelBlockIds);
		}
		return {
			blocks,
			firstLevelBlockIds
		};
	}
}
/** Convert markdown in chunks to avoid document.convert content size limits */
async function chunkedConvertMarkdown(client, markdown) {
	const chunks = splitMarkdownByHeadings(markdown);
	const allBlocks = [];
	const allFirstLevelBlockIds = [];
	for (const chunk of chunks) {
		const { blocks, firstLevelBlockIds } = await convertMarkdownWithFallback(client, chunk);
		const sorted = sortBlocksByFirstLevel(blocks, firstLevelBlockIds);
		allBlocks.push(...sorted);
		allFirstLevelBlockIds.push(...firstLevelBlockIds);
	}
	return {
		blocks: allBlocks,
		firstLevelBlockIds: allFirstLevelBlockIds
	};
}
/**
* Insert blocks using the Descendant API (supports tables, nested lists, large docs).
* Unlike the Children API, this supports block_type 31/32 (Table/TableCell).
*
* @param parentBlockId - Parent block to insert into (defaults to docToken = document root)
* @param index - Position within parent's children (-1 = end, 0 = first)
*/
async function insertBlocksWithDescendant(client, docToken, blocks, firstLevelBlockIds, { parentBlockId = docToken, index = -1 } = {}) {
	const descendants = cleanBlocksForDescendant(blocks);
	if (descendants.length === 0) return { children: [] };
	const res = await client.docx.documentBlockDescendant.create({
		path: {
			document_id: docToken,
			block_id: parentBlockId
		},
		data: {
			children_id: firstLevelBlockIds,
			descendants,
			index
		}
	});
	if (res.code !== 0) throw new Error(`${res.msg} (code: ${res.code})`);
	return { children: res.data?.children ?? [] };
}
async function clearDocumentContent(client, docToken) {
	const existing = await client.docx.documentBlock.list({ path: { document_id: docToken } });
	if (existing.code !== 0) throw new Error(existing.msg);
	const childIds = existing.data?.items?.filter((b) => b.parent_id === docToken && b.block_type !== 1).map((b) => b.block_id) ?? [];
	if (childIds.length > 0) {
		const res = await client.docx.documentBlockChildren.batchDelete({
			path: {
				document_id: docToken,
				block_id: docToken
			},
			data: {
				start_index: 0,
				end_index: childIds.length
			}
		});
		if (res.code !== 0) throw new Error(res.msg);
	}
	return childIds.length;
}
async function uploadImageToDocx(client, blockId, imageBuffer, fileName, docToken) {
	const fileToken = (await client.drive.media.uploadAll({ data: {
		file_name: fileName,
		parent_type: "docx_image",
		parent_node: blockId,
		size: imageBuffer.length,
		file: imageBuffer,
		...docToken ? { extra: JSON.stringify({ drive_route_token: docToken }) } : {}
	} }))?.file_token;
	if (!fileToken) throw new Error("Image upload failed: no file_token returned");
	return fileToken;
}
async function downloadImage(url, maxBytes) {
	return (await getFeishuRuntime().channel.media.fetchRemoteMedia({
		url,
		maxBytes
	})).buffer;
}
async function resolveUploadInput(url, filePath, maxBytes, explicitFileName, imageInput) {
	const inputSources = [
		url ? "url" : null,
		filePath ? "file_path" : null,
		imageInput ? "image" : null
	].filter(Boolean);
	if (inputSources.length > 1) throw new Error(`Provide only one image source; got: ${inputSources.join(", ")}`);
	if (imageInput?.startsWith("data:")) {
		const commaIdx = imageInput.indexOf(",");
		if (commaIdx === -1) throw new Error("Invalid data URI: missing comma separator.");
		const header = imageInput.slice(0, commaIdx);
		const data = imageInput.slice(commaIdx + 1);
		if (!header.includes(";base64")) throw new Error("Invalid data URI: missing ';base64' marker. Expected format: data:image/png;base64,<base64data>");
		const trimmedData = data.trim();
		if (trimmedData.length === 0 || !/^[A-Za-z0-9+/]+=*$/.test(trimmedData)) throw new Error(`Invalid data URI: base64 payload contains characters outside the standard alphabet.`);
		const ext = header.match(/data:([^;]+)/)?.[1]?.split("/")[1] ?? "png";
		const estimatedBytes = Math.ceil(trimmedData.length * 3 / 4);
		if (estimatedBytes > maxBytes) throw new Error(`Image data URI exceeds limit: estimated ${estimatedBytes} bytes > ${maxBytes} bytes`);
		return {
			buffer: Buffer.from(trimmedData, "base64"),
			fileName: explicitFileName ?? `image.${ext}`
		};
	}
	if (imageInput) {
		const candidate = imageInput.startsWith("~") ? imageInput.replace(/^~/, homedir()) : imageInput;
		const unambiguousPath = imageInput.startsWith("~") || imageInput.startsWith("./") || imageInput.startsWith("../");
		const absolutePath = isAbsolute(imageInput);
		if (unambiguousPath || absolutePath && existsSync(candidate)) {
			const buffer = await promises.readFile(candidate);
			if (buffer.length > maxBytes) throw new Error(`Local file exceeds limit: ${buffer.length} bytes > ${maxBytes} bytes`);
			return {
				buffer,
				fileName: explicitFileName ?? basename(candidate)
			};
		}
		if (absolutePath && !existsSync(candidate)) throw new Error(`File not found: "${candidate}". If you intended to pass image binary data, use a data URI instead: data:image/jpeg;base64,...`);
	}
	if (imageInput) {
		const trimmed = imageInput.trim();
		if (trimmed.length === 0 || !/^[A-Za-z0-9+/]+=*$/.test(trimmed)) throw new Error("Invalid base64: image input contains characters outside the standard base64 alphabet. Use a data URI (data:image/png;base64,...) or a local file path instead.");
		const estimatedBytes = Math.ceil(trimmed.length * 3 / 4);
		if (estimatedBytes > maxBytes) throw new Error(`Base64 image exceeds limit: estimated ${estimatedBytes} bytes > ${maxBytes} bytes`);
		const buffer = Buffer.from(trimmed, "base64");
		if (buffer.length === 0) throw new Error("Base64 image decoded to empty buffer; check the input.");
		return {
			buffer,
			fileName: explicitFileName ?? "image.png"
		};
	}
	if (!url && !filePath) throw new Error("Either url, file_path, or image (base64/data URI) must be provided");
	if (url && filePath) throw new Error("Provide only one of url or file_path");
	if (url) {
		const fetched = await getFeishuRuntime().channel.media.fetchRemoteMedia({
			url,
			maxBytes
		});
		const guessed = new URL(url).pathname.split("/").pop() || "upload.bin";
		return {
			buffer: fetched.buffer,
			fileName: explicitFileName || guessed
		};
	}
	const buffer = await promises.readFile(filePath);
	if (buffer.length > maxBytes) throw new Error(`Local file exceeds limit: ${buffer.length} bytes > ${maxBytes} bytes`);
	return {
		buffer,
		fileName: explicitFileName || basename(filePath)
	};
}
async function processImages(client, docToken, markdown, insertedBlocks, maxBytes) {
	const imageUrls = extractImageUrls(markdown);
	if (imageUrls.length === 0) return 0;
	const imageBlocks = insertedBlocks.filter((b) => b.block_type === 27);
	let processed = 0;
	for (let i = 0; i < Math.min(imageUrls.length, imageBlocks.length); i++) {
		const url = imageUrls[i];
		const blockId = imageBlocks[i].block_id;
		try {
			const fileToken = await uploadImageToDocx(client, blockId, await downloadImage(url, maxBytes), new URL(url).pathname.split("/").pop() || `image_${i}.png`, docToken);
			await client.docx.documentBlock.patch({
				path: {
					document_id: docToken,
					block_id: blockId
				},
				data: { replace_image: { token: fileToken } }
			});
			processed++;
		} catch (err) {
			console.error(`Failed to process image ${url}:`, err);
		}
	}
	return processed;
}
async function uploadImageBlock(client, docToken, maxBytes, url, filePath, parentBlockId, filename, index, imageInput) {
	const insertRes = await client.docx.documentBlockChildren.create({
		path: {
			document_id: docToken,
			block_id: parentBlockId ?? docToken
		},
		params: { document_revision_id: -1 },
		data: {
			children: [{
				block_type: 27,
				image: {}
			}],
			index: index ?? -1
		}
	});
	if (insertRes.code !== 0) throw new Error(`Failed to create image block: ${insertRes.msg}`);
	const imageBlockId = insertRes.data?.children?.find((b) => b.block_type === 27)?.block_id;
	if (!imageBlockId) throw new Error("Failed to create image block");
	const upload = await resolveUploadInput(url, filePath, maxBytes, filename, imageInput);
	const fileToken = await uploadImageToDocx(client, imageBlockId, upload.buffer, upload.fileName, docToken);
	const patchRes = await client.docx.documentBlock.patch({
		path: {
			document_id: docToken,
			block_id: imageBlockId
		},
		data: { replace_image: { token: fileToken } }
	});
	if (patchRes.code !== 0) throw new Error(patchRes.msg);
	return {
		success: true,
		block_id: imageBlockId,
		file_token: fileToken,
		file_name: upload.fileName,
		size: upload.buffer.length
	};
}
async function uploadFileBlock(client, docToken, maxBytes, url, filePath, parentBlockId, filename) {
	const blockId = parentBlockId ?? docToken;
	const upload = await resolveUploadInput(url, filePath, maxBytes, filename);
	const converted = await convertMarkdown(client, `[${upload.fileName}](https://example.com/placeholder)`);
	const { children: inserted } = await insertBlocks(client, docToken, sortBlocksByFirstLevel(converted.blocks, converted.firstLevelBlockIds), blockId);
	const placeholderBlock = inserted[0];
	if (!placeholderBlock?.block_id) throw new Error("Failed to create placeholder block for file upload");
	const parentId = placeholderBlock.parent_id ?? blockId;
	const childrenRes = await client.docx.documentBlockChildren.get({ path: {
		document_id: docToken,
		block_id: parentId
	} });
	if (childrenRes.code !== 0) throw new Error(childrenRes.msg);
	const placeholderIdx = (childrenRes.data?.items ?? []).findIndex((item) => item.block_id === placeholderBlock.block_id);
	if (placeholderIdx >= 0) {
		const deleteRes = await client.docx.documentBlockChildren.batchDelete({
			path: {
				document_id: docToken,
				block_id: parentId
			},
			data: {
				start_index: placeholderIdx,
				end_index: placeholderIdx + 1
			}
		});
		if (deleteRes.code !== 0) throw new Error(deleteRes.msg);
	}
	const fileToken = (await client.drive.media.uploadAll({ data: {
		file_name: upload.fileName,
		parent_type: "docx_file",
		parent_node: docToken,
		size: upload.buffer.length,
		file: upload.buffer
	} }))?.file_token;
	if (!fileToken) throw new Error("File upload failed: no file_token returned");
	return {
		success: true,
		file_token: fileToken,
		file_name: upload.fileName,
		size: upload.buffer.length,
		note: "File uploaded to drive. Use the file_token to reference it. Direct file block creation is not supported by the Feishu API."
	};
}
const STRUCTURED_BLOCK_TYPES = new Set([
	14,
	18,
	21,
	23,
	27,
	30,
	31,
	32
]);
async function readDoc(client, docToken) {
	const [contentRes, infoRes, blocksRes] = await Promise.all([
		client.docx.document.rawContent({ path: { document_id: docToken } }),
		client.docx.document.get({ path: { document_id: docToken } }),
		client.docx.documentBlock.list({ path: { document_id: docToken } })
	]);
	if (contentRes.code !== 0) throw new Error(contentRes.msg);
	const blocks = blocksRes.data?.items ?? [];
	const blockCounts = {};
	const structuredTypes = [];
	for (const b of blocks) {
		const type = b.block_type ?? 0;
		const name = BLOCK_TYPE_NAMES[type] || `type_${type}`;
		blockCounts[name] = (blockCounts[name] || 0) + 1;
		if (STRUCTURED_BLOCK_TYPES.has(type) && !structuredTypes.includes(name)) structuredTypes.push(name);
	}
	let hint;
	if (structuredTypes.length > 0) hint = `This document contains ${structuredTypes.join(", ")} which are NOT included in the plain text above. Use feishu_doc with action: "list_blocks" to get full content.`;
	return {
		title: infoRes.data?.document?.title,
		content: contentRes.data?.content,
		revision_id: infoRes.data?.document?.revision_id,
		block_count: blocks.length,
		block_types: blockCounts,
		...hint && { hint }
	};
}
async function createDoc(client, title, folderToken, options) {
	const res = await client.docx.document.create({ data: {
		title,
		folder_token: folderToken
	} });
	if (res.code !== 0) throw new Error(res.msg);
	const doc = res.data?.document;
	const docToken = doc?.document_id;
	if (!docToken) throw new Error("Document creation succeeded but no document_id was returned");
	const shouldGrantToRequester = options?.grantToRequester !== false;
	const requesterOpenId = options?.requesterOpenId?.trim();
	const requesterPermType = "edit";
	let requesterPermissionAdded = false;
	let requesterPermissionSkippedReason;
	let requesterPermissionError;
	if (shouldGrantToRequester) if (!requesterOpenId) requesterPermissionSkippedReason = "trusted requester identity unavailable";
	else try {
		await client.drive.permissionMember.create({
			path: { token: docToken },
			params: {
				type: "docx",
				need_notification: false
			},
			data: {
				member_type: "openid",
				member_id: requesterOpenId,
				perm: requesterPermType
			}
		});
		requesterPermissionAdded = true;
	} catch (err) {
		requesterPermissionError = err instanceof Error ? err.message : String(err);
	}
	return {
		document_id: docToken,
		title: doc?.title,
		url: `https://feishu.cn/docx/${docToken}`,
		...shouldGrantToRequester && {
			requester_permission_added: requesterPermissionAdded,
			...requesterOpenId && { requester_open_id: requesterOpenId },
			requester_perm_type: requesterPermType,
			...requesterPermissionSkippedReason && { requester_permission_skipped_reason: requesterPermissionSkippedReason },
			...requesterPermissionError && { requester_permission_error: requesterPermissionError }
		}
	};
}
async function writeDoc(client, docToken, markdown, maxBytes, logger) {
	const deleted = await clearDocumentContent(client, docToken);
	logger?.info?.("feishu_doc: Converting markdown...");
	const { blocks, firstLevelBlockIds } = await chunkedConvertMarkdown(client, markdown);
	if (blocks.length === 0) return {
		success: true,
		blocks_deleted: deleted,
		blocks_added: 0,
		images_processed: 0
	};
	logger?.info?.(`feishu_doc: Converted to ${blocks.length} blocks, inserting...`);
	const sortedBlocks = sortBlocksByFirstLevel(blocks, firstLevelBlockIds);
	const { children: inserted } = blocks.length > 1e3 ? await insertBlocksInBatches(client, docToken, sortedBlocks, firstLevelBlockIds, logger) : await insertBlocksWithDescendant(client, docToken, sortedBlocks, firstLevelBlockIds);
	const imagesProcessed = await processImages(client, docToken, markdown, inserted, maxBytes);
	logger?.info?.(`feishu_doc: Done (${blocks.length} blocks, ${imagesProcessed} images)`);
	return {
		success: true,
		blocks_deleted: deleted,
		blocks_added: blocks.length,
		images_processed: imagesProcessed
	};
}
async function appendDoc(client, docToken, markdown, maxBytes, logger) {
	logger?.info?.("feishu_doc: Converting markdown...");
	const { blocks, firstLevelBlockIds } = await chunkedConvertMarkdown(client, markdown);
	if (blocks.length === 0) throw new Error("Content is empty");
	logger?.info?.(`feishu_doc: Converted to ${blocks.length} blocks, inserting...`);
	const sortedBlocks = sortBlocksByFirstLevel(blocks, firstLevelBlockIds);
	const { children: inserted } = blocks.length > 1e3 ? await insertBlocksInBatches(client, docToken, sortedBlocks, firstLevelBlockIds, logger) : await insertBlocksWithDescendant(client, docToken, sortedBlocks, firstLevelBlockIds);
	const imagesProcessed = await processImages(client, docToken, markdown, inserted, maxBytes);
	logger?.info?.(`feishu_doc: Done (${blocks.length} blocks, ${imagesProcessed} images)`);
	return {
		success: true,
		blocks_added: blocks.length,
		images_processed: imagesProcessed,
		block_ids: inserted.map((b) => b.block_id)
	};
}
async function insertDoc(client, docToken, markdown, afterBlockId, maxBytes, logger) {
	const blockInfo = await client.docx.documentBlock.get({ path: {
		document_id: docToken,
		block_id: afterBlockId
	} });
	if (blockInfo.code !== 0) throw new Error(blockInfo.msg);
	const parentId = blockInfo.data?.block?.parent_id ?? docToken;
	const items = [];
	let pageToken;
	do {
		const childrenRes = await client.docx.documentBlockChildren.get({
			path: {
				document_id: docToken,
				block_id: parentId
			},
			params: pageToken ? { page_token: pageToken } : {}
		});
		if (childrenRes.code !== 0) throw new Error(childrenRes.msg);
		items.push(...childrenRes.data?.items ?? []);
		pageToken = childrenRes.data?.page_token ?? void 0;
	} while (pageToken);
	const blockIndex = items.findIndex((item) => item.block_id === afterBlockId);
	if (blockIndex === -1) throw new Error(`after_block_id "${afterBlockId}" was not found among the children of parent block "${parentId}". Use list_blocks to verify the block ID.`);
	const insertIndex = blockIndex + 1;
	logger?.info?.("feishu_doc: Converting markdown...");
	const { blocks, firstLevelBlockIds } = await chunkedConvertMarkdown(client, markdown);
	if (blocks.length === 0) throw new Error("Content is empty");
	const sortedBlocks = sortBlocksByFirstLevel(blocks, firstLevelBlockIds);
	logger?.info?.(`feishu_doc: Converted to ${blocks.length} blocks, inserting at index ${insertIndex}...`);
	const { children: inserted } = blocks.length > 1e3 ? await insertBlocksInBatches(client, docToken, sortedBlocks, firstLevelBlockIds, logger, parentId, insertIndex) : await insertBlocksWithDescendant(client, docToken, sortedBlocks, firstLevelBlockIds, {
		parentBlockId: parentId,
		index: insertIndex
	});
	const imagesProcessed = await processImages(client, docToken, markdown, inserted, maxBytes);
	logger?.info?.(`feishu_doc: Done (${blocks.length} blocks, ${imagesProcessed} images)`);
	return {
		success: true,
		blocks_added: blocks.length,
		images_processed: imagesProcessed,
		block_ids: inserted.map((b) => b.block_id)
	};
}
async function createTable(client, docToken, rowSize, columnSize, parentBlockId, columnWidth) {
	if (columnWidth && columnWidth.length !== columnSize) throw new Error("column_width length must equal column_size");
	const blockId = parentBlockId ?? docToken;
	const res = await client.docx.documentBlockChildren.create({
		path: {
			document_id: docToken,
			block_id: blockId
		},
		data: { children: [{
			block_type: 31,
			table: { property: {
				row_size: rowSize,
				column_size: columnSize,
				...columnWidth && columnWidth.length > 0 ? { column_width: columnWidth } : {}
			} }
		}] }
	});
	if (res.code !== 0) throw new Error(res.msg);
	const tableBlock = (res.data?.children)?.find((b) => b.block_type === 31);
	const cells = tableBlock?.children ?? [];
	return {
		success: true,
		table_block_id: tableBlock?.block_id,
		row_size: rowSize,
		column_size: columnSize,
		table_cell_block_ids: cells.map((c) => c.block_id).filter(Boolean),
		raw_children_count: res.data?.children?.length ?? 0
	};
}
async function writeTableCells(client, docToken, tableBlockId, values) {
	if (!values.length || !values[0]?.length) throw new Error("values must be a non-empty 2D array");
	const tableRes = await client.docx.documentBlock.get({ path: {
		document_id: docToken,
		block_id: tableBlockId
	} });
	if (tableRes.code !== 0) throw new Error(tableRes.msg);
	const tableBlock = tableRes.data?.block;
	if (tableBlock?.block_type !== 31) throw new Error("table_block_id is not a table block");
	const tableData = tableBlock.table;
	const rows = tableData?.property?.row_size;
	const cols = tableData?.property?.column_size;
	const cellIds = tableData?.cells ?? [];
	if (!rows || !cols || !cellIds.length) throw new Error("Table cell IDs unavailable from table block. Use list_blocks/get_block and pass explicit cell block IDs if needed.");
	const writeRows = Math.min(values.length, rows);
	let written = 0;
	for (let r = 0; r < writeRows; r++) {
		const rowValues = values[r] ?? [];
		const writeCols = Math.min(rowValues.length, cols);
		for (let c = 0; c < writeCols; c++) {
			const cellId = cellIds[r * cols + c];
			if (!cellId) continue;
			const childrenRes = await client.docx.documentBlockChildren.get({ path: {
				document_id: docToken,
				block_id: cellId
			} });
			if (childrenRes.code !== 0) throw new Error(childrenRes.msg);
			const existingChildren = childrenRes.data?.items ?? [];
			if (existingChildren.length > 0) {
				const delRes = await client.docx.documentBlockChildren.batchDelete({
					path: {
						document_id: docToken,
						block_id: cellId
					},
					data: {
						start_index: 0,
						end_index: existingChildren.length
					}
				});
				if (delRes.code !== 0) throw new Error(delRes.msg);
			}
			const converted = await convertMarkdown(client, rowValues[c] ?? "");
			const sorted = sortBlocksByFirstLevel(converted.blocks, converted.firstLevelBlockIds);
			if (sorted.length > 0) await insertBlocks(client, docToken, sorted, cellId);
			written++;
		}
	}
	return {
		success: true,
		table_block_id: tableBlockId,
		cells_written: written,
		table_size: {
			rows,
			cols
		}
	};
}
async function createTableWithValues(client, docToken, rowSize, columnSize, values, parentBlockId, columnWidth) {
	const tableBlockId = (await createTable(client, docToken, rowSize, columnSize, parentBlockId, columnWidth)).table_block_id;
	if (!tableBlockId) throw new Error("create_table succeeded but table_block_id is missing");
	return {
		success: true,
		table_block_id: tableBlockId,
		row_size: rowSize,
		column_size: columnSize,
		cells_written: (await writeTableCells(client, docToken, tableBlockId, values)).cells_written
	};
}
async function updateBlock(client, docToken, blockId, content) {
	const blockInfo = await client.docx.documentBlock.get({ path: {
		document_id: docToken,
		block_id: blockId
	} });
	if (blockInfo.code !== 0) throw new Error(blockInfo.msg);
	const res = await client.docx.documentBlock.patch({
		path: {
			document_id: docToken,
			block_id: blockId
		},
		data: { update_text_elements: { elements: [{ text_run: { content } }] } }
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		success: true,
		block_id: blockId
	};
}
async function deleteBlock(client, docToken, blockId) {
	const blockInfo = await client.docx.documentBlock.get({ path: {
		document_id: docToken,
		block_id: blockId
	} });
	if (blockInfo.code !== 0) throw new Error(blockInfo.msg);
	const parentId = blockInfo.data?.block?.parent_id ?? docToken;
	const children = await client.docx.documentBlockChildren.get({ path: {
		document_id: docToken,
		block_id: parentId
	} });
	if (children.code !== 0) throw new Error(children.msg);
	const index = (children.data?.items ?? []).findIndex((item) => item.block_id === blockId);
	if (index === -1) throw new Error("Block not found");
	const res = await client.docx.documentBlockChildren.batchDelete({
		path: {
			document_id: docToken,
			block_id: parentId
		},
		data: {
			start_index: index,
			end_index: index + 1
		}
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		success: true,
		deleted_block_id: blockId
	};
}
async function listBlocks(client, docToken) {
	const res = await client.docx.documentBlock.list({ path: { document_id: docToken } });
	if (res.code !== 0) throw new Error(res.msg);
	return { blocks: res.data?.items ?? [] };
}
async function getBlock(client, docToken, blockId) {
	const res = await client.docx.documentBlock.get({ path: {
		document_id: docToken,
		block_id: blockId
	} });
	if (res.code !== 0) throw new Error(res.msg);
	return { block: res.data?.block };
}
async function listAppScopes(client) {
	const res = await client.application.scope.list({});
	if (res.code !== 0) throw new Error(res.msg);
	const scopes = res.data?.scopes ?? [];
	const granted = scopes.filter((s) => s.grant_status === 1);
	const pending = scopes.filter((s) => s.grant_status !== 1);
	return {
		granted: granted.map((s) => ({
			name: s.scope_name,
			type: s.scope_type
		})),
		pending: pending.map((s) => ({
			name: s.scope_name,
			type: s.scope_type
		})),
		summary: `${granted.length} granted, ${pending.length} pending`
	};
}
function registerFeishuDocTools(api) {
	if (!api.config) {
		api.logger.debug?.("feishu_doc: No config available, skipping doc tools");
		return;
	}
	const accounts = listEnabledFeishuAccounts(api.config);
	if (accounts.length === 0) {
		api.logger.debug?.("feishu_doc: No Feishu accounts configured, skipping doc tools");
		return;
	}
	const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
	const registered = [];
	const getClient = (params, defaultAccountId) => createFeishuToolClient({
		api,
		executeParams: params,
		defaultAccountId
	});
	const getMediaMaxBytes = (params, defaultAccountId) => (resolveFeishuToolAccount({
		api,
		executeParams: params,
		defaultAccountId
	}).config?.mediaMaxMb ?? 30) * 1024 * 1024;
	if (toolsCfg.doc) {
		api.registerTool((ctx) => {
			const defaultAccountId = ctx.agentAccountId;
			const trustedRequesterOpenId = ctx.messageChannel === "feishu" ? ctx.requesterSenderId?.trim() || void 0 : void 0;
			return {
				name: "feishu_doc",
				label: "Feishu Doc",
				description: "Feishu document operations. Actions: read, write, append, insert, create, list_blocks, get_block, update_block, delete_block, create_table, write_table_cells, create_table_with_values, insert_table_row, insert_table_column, delete_table_rows, delete_table_columns, merge_table_cells, upload_image, upload_file, color_text",
				parameters: FeishuDocSchema,
				async execute(_toolCallId, params) {
					const p = params;
					try {
						const client = getClient(p, defaultAccountId);
						switch (p.action) {
							case "read": return json(await readDoc(client, p.doc_token));
							case "write": return json(await writeDoc(client, p.doc_token, p.content, getMediaMaxBytes(p, defaultAccountId), api.logger));
							case "append": return json(await appendDoc(client, p.doc_token, p.content, getMediaMaxBytes(p, defaultAccountId), api.logger));
							case "insert": return json(await insertDoc(client, p.doc_token, p.content, p.after_block_id, getMediaMaxBytes(p, defaultAccountId), api.logger));
							case "create": return json(await createDoc(client, p.title, p.folder_token, {
								grantToRequester: p.grant_to_requester,
								requesterOpenId: trustedRequesterOpenId
							}));
							case "list_blocks": return json(await listBlocks(client, p.doc_token));
							case "get_block": return json(await getBlock(client, p.doc_token, p.block_id));
							case "update_block": return json(await updateBlock(client, p.doc_token, p.block_id, p.content));
							case "delete_block": return json(await deleteBlock(client, p.doc_token, p.block_id));
							case "create_table": return json(await createTable(client, p.doc_token, p.row_size, p.column_size, p.parent_block_id, p.column_width));
							case "write_table_cells": return json(await writeTableCells(client, p.doc_token, p.table_block_id, p.values));
							case "create_table_with_values": return json(await createTableWithValues(client, p.doc_token, p.row_size, p.column_size, p.values, p.parent_block_id, p.column_width));
							case "upload_image": return json(await uploadImageBlock(client, p.doc_token, getMediaMaxBytes(p, defaultAccountId), p.url, p.file_path, p.parent_block_id, p.filename, p.index, p.image));
							case "upload_file": return json(await uploadFileBlock(client, p.doc_token, getMediaMaxBytes(p, defaultAccountId), p.url, p.file_path, p.parent_block_id, p.filename));
							case "color_text": return json(await updateColorText(client, p.doc_token, p.block_id, p.content));
							case "insert_table_row": return json(await insertTableRow(client, p.doc_token, p.block_id, p.row_index));
							case "insert_table_column": return json(await insertTableColumn(client, p.doc_token, p.block_id, p.column_index));
							case "delete_table_rows": return json(await deleteTableRows(client, p.doc_token, p.block_id, p.row_start, p.row_count));
							case "delete_table_columns": return json(await deleteTableColumns(client, p.doc_token, p.block_id, p.column_start, p.column_count));
							case "merge_table_cells": return json(await mergeTableCells(client, p.doc_token, p.block_id, p.row_start, p.row_end, p.column_start, p.column_end));
							default: return json({ error: `Unknown action: ${p.action}` });
						}
					} catch (err) {
						return json({ error: err instanceof Error ? err.message : String(err) });
					}
				}
			};
		}, { name: "feishu_doc" });
		registered.push("feishu_doc");
	}
	if (toolsCfg.scopes) {
		api.registerTool((ctx) => ({
			name: "feishu_app_scopes",
			label: "Feishu App Scopes",
			description: "List current app permissions (scopes). Use to debug permission issues or check available capabilities.",
			parameters: Type.Object({}),
			async execute() {
				try {
					return json(await listAppScopes(getClient(void 0, ctx.agentAccountId)));
				} catch (err) {
					return json({ error: err instanceof Error ? err.message : String(err) });
				}
			}
		}), { name: "feishu_app_scopes" });
		registered.push("feishu_app_scopes");
	}
	if (registered.length > 0) api.logger.info?.(`feishu_doc: Registered ${registered.join(", ")}`);
}
//#endregion
//#region extensions/feishu/src/drive-schema.ts
const FileType = Type.Union([
	Type.Literal("doc"),
	Type.Literal("docx"),
	Type.Literal("sheet"),
	Type.Literal("bitable"),
	Type.Literal("folder"),
	Type.Literal("file"),
	Type.Literal("mindnote"),
	Type.Literal("shortcut")
]);
const FeishuDriveSchema = Type.Union([
	Type.Object({
		action: Type.Literal("list"),
		folder_token: Type.Optional(Type.String({ description: "Folder token (optional, omit for root directory)" }))
	}),
	Type.Object({
		action: Type.Literal("info"),
		file_token: Type.String({ description: "File or folder token" }),
		type: FileType
	}),
	Type.Object({
		action: Type.Literal("create_folder"),
		name: Type.String({ description: "Folder name" }),
		folder_token: Type.Optional(Type.String({ description: "Parent folder token (optional, omit for root)" }))
	}),
	Type.Object({
		action: Type.Literal("move"),
		file_token: Type.String({ description: "File token to move" }),
		type: FileType,
		folder_token: Type.String({ description: "Target folder token" })
	}),
	Type.Object({
		action: Type.Literal("delete"),
		file_token: Type.String({ description: "File token to delete" }),
		type: FileType
	})
]);
//#endregion
//#region extensions/feishu/src/tool-result.ts
function jsonToolResult(data) {
	return {
		content: [{
			type: "text",
			text: JSON.stringify(data, null, 2)
		}],
		details: data
	};
}
function unknownToolActionResult(action) {
	return jsonToolResult({ error: `Unknown action: ${String(action)}` });
}
function toolExecutionErrorResult(error) {
	return jsonToolResult({ error: error instanceof Error ? error.message : String(error) });
}
//#endregion
//#region extensions/feishu/src/drive.ts
async function getRootFolderToken(client) {
	const domain = client.domain ?? "https://open.feishu.cn";
	const res = await client.httpInstance.get(`${domain}/open-apis/drive/explorer/v2/root_folder/meta`);
	if (res.code !== 0) throw new Error(res.msg ?? "Failed to get root folder");
	const token = res.data?.token;
	if (!token) throw new Error("Root folder token not found");
	return token;
}
async function listFolder(client, folderToken) {
	const validFolderToken = folderToken && folderToken !== "0" ? folderToken : void 0;
	const res = await client.drive.file.list({ params: validFolderToken ? { folder_token: validFolderToken } : {} });
	if (res.code !== 0) throw new Error(res.msg);
	return {
		files: res.data?.files?.map((f) => ({
			token: f.token,
			name: f.name,
			type: f.type,
			url: f.url,
			created_time: f.created_time,
			modified_time: f.modified_time,
			owner_id: f.owner_id
		})) ?? [],
		next_page_token: res.data?.next_page_token
	};
}
async function getFileInfo(client, fileToken, folderToken) {
	const res = await client.drive.file.list({ params: folderToken ? { folder_token: folderToken } : {} });
	if (res.code !== 0) throw new Error(res.msg);
	const file = res.data?.files?.find((f) => f.token === fileToken);
	if (!file) throw new Error(`File not found: ${fileToken}`);
	return {
		token: file.token,
		name: file.name,
		type: file.type,
		url: file.url,
		created_time: file.created_time,
		modified_time: file.modified_time,
		owner_id: file.owner_id
	};
}
async function createFolder(client, name, folderToken) {
	let effectiveToken = folderToken && folderToken !== "0" ? folderToken : "0";
	if (effectiveToken === "0") try {
		effectiveToken = await getRootFolderToken(client);
	} catch {}
	const res = await client.drive.file.createFolder({ data: {
		name,
		folder_token: effectiveToken
	} });
	if (res.code !== 0) throw new Error(res.msg);
	return {
		token: res.data?.token,
		url: res.data?.url
	};
}
async function moveFile(client, fileToken, type, folderToken) {
	const res = await client.drive.file.move({
		path: { file_token: fileToken },
		data: {
			type,
			folder_token: folderToken
		}
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		success: true,
		task_id: res.data?.task_id
	};
}
async function deleteFile(client, fileToken, type) {
	const res = await client.drive.file.delete({
		path: { file_token: fileToken },
		params: { type }
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		success: true,
		task_id: res.data?.task_id
	};
}
function registerFeishuDriveTools(api) {
	if (!api.config) {
		api.logger.debug?.("feishu_drive: No config available, skipping drive tools");
		return;
	}
	const accounts = listEnabledFeishuAccounts(api.config);
	if (accounts.length === 0) {
		api.logger.debug?.("feishu_drive: No Feishu accounts configured, skipping drive tools");
		return;
	}
	if (!resolveAnyEnabledFeishuToolsConfig(accounts).drive) {
		api.logger.debug?.("feishu_drive: drive tool disabled in config");
		return;
	}
	api.registerTool((ctx) => {
		const defaultAccountId = ctx.agentAccountId;
		return {
			name: "feishu_drive",
			label: "Feishu Drive",
			description: "Feishu cloud storage operations. Actions: list, info, create_folder, move, delete",
			parameters: FeishuDriveSchema,
			async execute(_toolCallId, params) {
				const p = params;
				try {
					const client = createFeishuToolClient({
						api,
						executeParams: p,
						defaultAccountId
					});
					switch (p.action) {
						case "list": return jsonToolResult(await listFolder(client, p.folder_token));
						case "info": return jsonToolResult(await getFileInfo(client, p.file_token));
						case "create_folder": return jsonToolResult(await createFolder(client, p.name, p.folder_token));
						case "move": return jsonToolResult(await moveFile(client, p.file_token, p.type, p.folder_token));
						case "delete": return jsonToolResult(await deleteFile(client, p.file_token, p.type));
						default: return unknownToolActionResult(p.action);
					}
				} catch (err) {
					return toolExecutionErrorResult(err);
				}
			}
		};
	}, { name: "feishu_drive" });
	api.logger.info?.(`feishu_drive: Registered feishu_drive tool`);
}
//#endregion
//#region extensions/feishu/src/perm-schema.ts
const TokenType = Type.Union([
	Type.Literal("doc"),
	Type.Literal("docx"),
	Type.Literal("sheet"),
	Type.Literal("bitable"),
	Type.Literal("folder"),
	Type.Literal("file"),
	Type.Literal("wiki"),
	Type.Literal("mindnote")
]);
const MemberType = Type.Union([
	Type.Literal("email"),
	Type.Literal("openid"),
	Type.Literal("userid"),
	Type.Literal("unionid"),
	Type.Literal("openchat"),
	Type.Literal("opendepartmentid")
]);
const Permission = Type.Union([
	Type.Literal("view"),
	Type.Literal("edit"),
	Type.Literal("full_access")
]);
const FeishuPermSchema = Type.Union([
	Type.Object({
		action: Type.Literal("list"),
		token: Type.String({ description: "File token" }),
		type: TokenType
	}),
	Type.Object({
		action: Type.Literal("add"),
		token: Type.String({ description: "File token" }),
		type: TokenType,
		member_type: MemberType,
		member_id: Type.String({ description: "Member ID (email, open_id, user_id, etc.)" }),
		perm: Permission
	}),
	Type.Object({
		action: Type.Literal("remove"),
		token: Type.String({ description: "File token" }),
		type: TokenType,
		member_type: MemberType,
		member_id: Type.String({ description: "Member ID to remove" })
	})
]);
//#endregion
//#region extensions/feishu/src/perm.ts
async function listMembers(client, token, type) {
	const res = await client.drive.permissionMember.list({
		path: { token },
		params: { type }
	});
	if (res.code !== 0) throw new Error(res.msg);
	return { members: res.data?.items?.map((m) => ({
		member_type: m.member_type,
		member_id: m.member_id,
		perm: m.perm,
		name: m.name
	})) ?? [] };
}
async function addMember(client, token, type, memberType, memberId, perm) {
	const res = await client.drive.permissionMember.create({
		path: { token },
		params: {
			type,
			need_notification: false
		},
		data: {
			member_type: memberType,
			member_id: memberId,
			perm
		}
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		success: true,
		member: res.data?.member
	};
}
async function removeMember(client, token, type, memberType, memberId) {
	const res = await client.drive.permissionMember.delete({
		path: {
			token,
			member_id: memberId
		},
		params: {
			type,
			member_type: memberType
		}
	});
	if (res.code !== 0) throw new Error(res.msg);
	return { success: true };
}
function registerFeishuPermTools(api) {
	if (!api.config) {
		api.logger.debug?.("feishu_perm: No config available, skipping perm tools");
		return;
	}
	const accounts = listEnabledFeishuAccounts(api.config);
	if (accounts.length === 0) {
		api.logger.debug?.("feishu_perm: No Feishu accounts configured, skipping perm tools");
		return;
	}
	if (!resolveAnyEnabledFeishuToolsConfig(accounts).perm) {
		api.logger.debug?.("feishu_perm: perm tool disabled in config (default: false)");
		return;
	}
	api.registerTool((ctx) => {
		const defaultAccountId = ctx.agentAccountId;
		return {
			name: "feishu_perm",
			label: "Feishu Perm",
			description: "Feishu permission management. Actions: list, add, remove",
			parameters: FeishuPermSchema,
			async execute(_toolCallId, params) {
				const p = params;
				try {
					const client = createFeishuToolClient({
						api,
						executeParams: p,
						defaultAccountId
					});
					switch (p.action) {
						case "list": return jsonToolResult(await listMembers(client, p.token, p.type));
						case "add": return jsonToolResult(await addMember(client, p.token, p.type, p.member_type, p.member_id, p.perm));
						case "remove": return jsonToolResult(await removeMember(client, p.token, p.type, p.member_type, p.member_id));
						default: return unknownToolActionResult(p.action);
					}
				} catch (err) {
					return toolExecutionErrorResult(err);
				}
			}
		};
	}, { name: "feishu_perm" });
	api.logger.info?.(`feishu_perm: Registered feishu_perm tool`);
}
//#endregion
//#region extensions/feishu/src/subagent-hooks.ts
function summarizeError(err) {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return "error";
}
function stripProviderPrefix(raw) {
	return raw.replace(/^(feishu|lark):/i, "").trim();
}
function resolveFeishuRequesterConversation(params) {
	const manager = getFeishuThreadBindingManager(params.accountId);
	if (!manager) return null;
	const rawTo = params.to?.trim();
	const withoutProviderPrefix = rawTo ? stripProviderPrefix(rawTo) : "";
	const normalizedTarget = rawTo ? normalizeFeishuTarget(rawTo) : null;
	const threadId = params.threadId != null && params.threadId !== "" ? String(params.threadId).trim() : "";
	const isChatTarget = /^(chat|group|channel):/i.test(withoutProviderPrefix);
	const parsedRequesterTopic = normalizedTarget && threadId && isChatTarget ? parseFeishuConversationId({
		conversationId: buildFeishuConversationId({
			chatId: normalizedTarget,
			scope: "group_topic",
			topicId: threadId
		}),
		parentConversationId: normalizedTarget
	}) : null;
	const requesterSessionKey = params.requesterSessionKey?.trim();
	if (requesterSessionKey) {
		const existingBindings = manager.listBySessionKey(requesterSessionKey);
		if (existingBindings.length === 1) {
			const existing = existingBindings[0];
			return {
				accountId: existing.accountId,
				conversationId: existing.conversationId,
				parentConversationId: existing.parentConversationId
			};
		}
		if (existingBindings.length > 1) {
			if (rawTo && normalizedTarget && !threadId && !isChatTarget) {
				const directMatches = existingBindings.filter((entry) => entry.accountId === manager.accountId && entry.conversationId === normalizedTarget && !entry.parentConversationId);
				if (directMatches.length === 1) {
					const existing = directMatches[0];
					return {
						accountId: existing.accountId,
						conversationId: existing.conversationId,
						parentConversationId: existing.parentConversationId
					};
				}
				return null;
			}
			if (parsedRequesterTopic) {
				const matchingTopicBindings = existingBindings.filter((entry) => {
					const parsed = parseFeishuConversationId({
						conversationId: entry.conversationId,
						parentConversationId: entry.parentConversationId
					});
					return parsed?.chatId === parsedRequesterTopic.chatId && parsed?.topicId === parsedRequesterTopic.topicId;
				});
				if (matchingTopicBindings.length === 1) {
					const existing = matchingTopicBindings[0];
					return {
						accountId: existing.accountId,
						conversationId: existing.conversationId,
						parentConversationId: existing.parentConversationId
					};
				}
				const senderScopedTopicBindings = matchingTopicBindings.filter((entry) => {
					return parseFeishuConversationId({
						conversationId: entry.conversationId,
						parentConversationId: entry.parentConversationId
					})?.scope === "group_topic_sender";
				});
				if (senderScopedTopicBindings.length === 1 && matchingTopicBindings.length === senderScopedTopicBindings.length) {
					const existing = senderScopedTopicBindings[0];
					return {
						accountId: existing.accountId,
						conversationId: existing.conversationId,
						parentConversationId: existing.parentConversationId
					};
				}
				return null;
			}
		}
	}
	if (!rawTo) return null;
	if (!normalizedTarget) return null;
	if (threadId) {
		if (!isChatTarget) return null;
		return {
			accountId: manager.accountId,
			conversationId: buildFeishuConversationId({
				chatId: normalizedTarget,
				scope: "group_topic",
				topicId: threadId
			}),
			parentConversationId: normalizedTarget
		};
	}
	if (isChatTarget) return null;
	return {
		accountId: manager.accountId,
		conversationId: normalizedTarget
	};
}
function resolveFeishuDeliveryOrigin(params) {
	const deliveryTo = params.deliveryTo?.trim();
	const deliveryThreadId = params.deliveryThreadId?.trim();
	if (deliveryTo) return {
		channel: "feishu",
		accountId: params.accountId,
		to: deliveryTo,
		...deliveryThreadId ? { threadId: deliveryThreadId } : {}
	};
	const parsed = parseFeishuConversationId({
		conversationId: params.conversationId,
		parentConversationId: params.parentConversationId
	});
	if (parsed?.topicId) return {
		channel: "feishu",
		accountId: params.accountId,
		to: `chat:${params.parentConversationId?.trim() || parsed.chatId}`,
		threadId: parsed.topicId
	};
	return {
		channel: "feishu",
		accountId: params.accountId,
		to: `user:${params.conversationId}`
	};
}
function resolveMatchingChildBinding(params) {
	const manager = getFeishuThreadBindingManager(params.accountId);
	if (!manager) return null;
	const childBindings = manager.listBySessionKey(params.childSessionKey.trim());
	if (childBindings.length === 0) return null;
	const requesterConversation = resolveFeishuRequesterConversation({
		accountId: manager.accountId,
		to: params.requesterOrigin?.to,
		threadId: params.requesterOrigin?.threadId,
		requesterSessionKey: params.requesterSessionKey
	});
	if (requesterConversation) {
		const matched = childBindings.find((entry) => entry.accountId === requesterConversation.accountId && entry.conversationId === requesterConversation.conversationId && (entry.parentConversationId?.trim() || void 0) === (requesterConversation.parentConversationId?.trim() || void 0));
		if (matched) return matched;
	}
	return childBindings.length === 1 ? childBindings[0] : null;
}
function registerFeishuSubagentHooks(api) {
	api.on("subagent_spawning", async (event, ctx) => {
		if (!event.threadRequested) return;
		if (event.requester?.channel?.trim().toLowerCase() !== "feishu") return;
		const manager = getFeishuThreadBindingManager(event.requester?.accountId);
		if (!manager) return {
			status: "error",
			error: "Feishu current-conversation binding is unavailable because the Feishu account monitor is not active."
		};
		const conversation = resolveFeishuRequesterConversation({
			accountId: event.requester?.accountId,
			to: event.requester?.to,
			threadId: event.requester?.threadId,
			requesterSessionKey: ctx.requesterSessionKey
		});
		if (!conversation) return {
			status: "error",
			error: "Feishu current-conversation binding is only available in direct messages or topic conversations."
		};
		try {
			if (!manager.bindConversation({
				conversationId: conversation.conversationId,
				parentConversationId: conversation.parentConversationId,
				targetKind: "subagent",
				targetSessionKey: event.childSessionKey,
				metadata: {
					agentId: event.agentId,
					label: event.label,
					boundBy: "system",
					deliveryTo: event.requester?.to,
					deliveryThreadId: event.requester?.threadId != null && event.requester.threadId !== "" ? String(event.requester.threadId) : void 0
				}
			})) return {
				status: "error",
				error: "Unable to bind this Feishu conversation to the spawned subagent session. Session mode is unavailable for this target."
			};
			return {
				status: "ok",
				threadBindingReady: true
			};
		} catch (err) {
			return {
				status: "error",
				error: `Feishu conversation bind failed: ${summarizeError(err)}`
			};
		}
	});
	api.on("subagent_delivery_target", (event) => {
		if (!event.expectsCompletionMessage) return;
		if (event.requesterOrigin?.channel?.trim().toLowerCase() !== "feishu") return;
		const binding = resolveMatchingChildBinding({
			accountId: event.requesterOrigin?.accountId,
			childSessionKey: event.childSessionKey,
			requesterSessionKey: event.requesterSessionKey,
			requesterOrigin: {
				to: event.requesterOrigin?.to,
				threadId: event.requesterOrigin?.threadId
			}
		});
		if (!binding) return;
		return { origin: resolveFeishuDeliveryOrigin({
			conversationId: binding.conversationId,
			parentConversationId: binding.parentConversationId,
			accountId: binding.accountId,
			deliveryTo: binding.deliveryTo,
			deliveryThreadId: binding.deliveryThreadId
		}) };
	});
	api.on("subagent_ended", (event) => {
		getFeishuThreadBindingManager(event.accountId)?.unbindBySessionKey(event.targetSessionKey);
	});
}
//#endregion
//#region extensions/feishu/src/wiki-schema.ts
const FeishuWikiSchema = Type.Union([
	Type.Object({ action: Type.Literal("spaces") }),
	Type.Object({
		action: Type.Literal("nodes"),
		space_id: Type.String({ description: "Knowledge space ID" }),
		parent_node_token: Type.Optional(Type.String({ description: "Parent node token (optional, omit for root)" }))
	}),
	Type.Object({
		action: Type.Literal("get"),
		token: Type.String({ description: "Wiki node token (from URL /wiki/XXX)" })
	}),
	Type.Object({
		action: Type.Literal("search"),
		query: Type.String({ description: "Search query" }),
		space_id: Type.Optional(Type.String({ description: "Limit search to this space (optional)" }))
	}),
	Type.Object({
		action: Type.Literal("create"),
		space_id: Type.String({ description: "Knowledge space ID" }),
		title: Type.String({ description: "Node title" }),
		obj_type: Type.Optional(Type.Union([
			Type.Literal("docx"),
			Type.Literal("sheet"),
			Type.Literal("bitable")
		], { description: "Object type (default: docx)" })),
		parent_node_token: Type.Optional(Type.String({ description: "Parent node token (optional, omit for root)" }))
	}),
	Type.Object({
		action: Type.Literal("move"),
		space_id: Type.String({ description: "Source knowledge space ID" }),
		node_token: Type.String({ description: "Node token to move" }),
		target_space_id: Type.Optional(Type.String({ description: "Target space ID (optional, same space if omitted)" })),
		target_parent_token: Type.Optional(Type.String({ description: "Target parent node token (optional, root if omitted)" }))
	}),
	Type.Object({
		action: Type.Literal("rename"),
		space_id: Type.String({ description: "Knowledge space ID" }),
		node_token: Type.String({ description: "Node token to rename" }),
		title: Type.String({ description: "New title" })
	})
]);
//#endregion
//#region extensions/feishu/src/wiki.ts
const WIKI_ACCESS_HINT = "To grant wiki access: Open wiki space → Settings → Members → Add the bot. See: https://open.feishu.cn/document/server-docs/docs/wiki-v2/wiki-qa#a40ad4ca";
async function listSpaces(client) {
	const res = await client.wiki.space.list({});
	if (res.code !== 0) throw new Error(res.msg);
	const spaces = res.data?.items?.map((s) => ({
		space_id: s.space_id,
		name: s.name,
		description: s.description,
		visibility: s.visibility
	})) ?? [];
	return {
		spaces,
		...spaces.length === 0 && { hint: WIKI_ACCESS_HINT }
	};
}
async function listNodes(client, spaceId, parentNodeToken) {
	const res = await client.wiki.spaceNode.list({
		path: { space_id: spaceId },
		params: { parent_node_token: parentNodeToken }
	});
	if (res.code !== 0) throw new Error(res.msg);
	return { nodes: res.data?.items?.map((n) => ({
		node_token: n.node_token,
		obj_token: n.obj_token,
		obj_type: n.obj_type,
		title: n.title,
		has_child: n.has_child
	})) ?? [] };
}
async function getNode(client, token) {
	const res = await client.wiki.space.getNode({ params: { token } });
	if (res.code !== 0) throw new Error(res.msg);
	const node = res.data?.node;
	return {
		node_token: node?.node_token,
		space_id: node?.space_id,
		obj_token: node?.obj_token,
		obj_type: node?.obj_type,
		title: node?.title,
		parent_node_token: node?.parent_node_token,
		has_child: node?.has_child,
		creator: node?.creator,
		create_time: node?.node_create_time
	};
}
async function createNode(client, spaceId, title, objType, parentNodeToken) {
	const res = await client.wiki.spaceNode.create({
		path: { space_id: spaceId },
		data: {
			obj_type: objType || "docx",
			node_type: "origin",
			title,
			parent_node_token: parentNodeToken
		}
	});
	if (res.code !== 0) throw new Error(res.msg);
	const node = res.data?.node;
	return {
		node_token: node?.node_token,
		obj_token: node?.obj_token,
		obj_type: node?.obj_type,
		title: node?.title
	};
}
async function moveNode(client, spaceId, nodeToken, targetSpaceId, targetParentToken) {
	const res = await client.wiki.spaceNode.move({
		path: {
			space_id: spaceId,
			node_token: nodeToken
		},
		data: {
			target_space_id: targetSpaceId || spaceId,
			target_parent_token: targetParentToken
		}
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		success: true,
		node_token: res.data?.node?.node_token
	};
}
async function renameNode(client, spaceId, nodeToken, title) {
	const res = await client.wiki.spaceNode.updateTitle({
		path: {
			space_id: spaceId,
			node_token: nodeToken
		},
		data: { title }
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		success: true,
		node_token: nodeToken,
		title
	};
}
function registerFeishuWikiTools(api) {
	if (!api.config) {
		api.logger.debug?.("feishu_wiki: No config available, skipping wiki tools");
		return;
	}
	const accounts = listEnabledFeishuAccounts(api.config);
	if (accounts.length === 0) {
		api.logger.debug?.("feishu_wiki: No Feishu accounts configured, skipping wiki tools");
		return;
	}
	if (!resolveAnyEnabledFeishuToolsConfig(accounts).wiki) {
		api.logger.debug?.("feishu_wiki: wiki tool disabled in config");
		return;
	}
	api.registerTool((ctx) => {
		const defaultAccountId = ctx.agentAccountId;
		return {
			name: "feishu_wiki",
			label: "Feishu Wiki",
			description: "Feishu knowledge base operations. Actions: spaces, nodes, get, create, move, rename",
			parameters: FeishuWikiSchema,
			async execute(_toolCallId, params) {
				const p = params;
				try {
					const client = createFeishuToolClient({
						api,
						executeParams: p,
						defaultAccountId
					});
					switch (p.action) {
						case "spaces": return jsonToolResult(await listSpaces(client));
						case "nodes": return jsonToolResult(await listNodes(client, p.space_id, p.parent_node_token));
						case "get": return jsonToolResult(await getNode(client, p.token));
						case "search": return jsonToolResult({ error: "Search is not available. Use feishu_wiki with action: 'nodes' to browse or action: 'get' to lookup by token." });
						case "create": return jsonToolResult(await createNode(client, p.space_id, p.title, p.obj_type, p.parent_node_token));
						case "move": return jsonToolResult(await moveNode(client, p.space_id, p.node_token, p.target_space_id, p.target_parent_token));
						case "rename": return jsonToolResult(await renameNode(client, p.space_id, p.node_token, p.title));
						default: return unknownToolActionResult(p.action);
					}
				} catch (err) {
					return toolExecutionErrorResult(err);
				}
			}
		};
	}, { name: "feishu_wiki" });
	api.logger.info?.(`feishu_wiki: Registered feishu_wiki tool`);
}
//#endregion
//#region extensions/feishu/index.ts
const plugin = {
	id: "feishu",
	name: "Feishu",
	description: "Feishu/Lark channel plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		setFeishuRuntime(api.runtime);
		api.registerChannel({ plugin: feishuPlugin });
		if (api.registrationMode !== "full") return;
		registerFeishuSubagentHooks(api);
		registerFeishuDocTools(api);
		registerFeishuChatTools(api);
		registerFeishuWikiTools(api);
		registerFeishuDriveTools(api);
		registerFeishuPermTools(api);
		registerFeishuBitableTools(api);
	}
};
//#endregion
export { FeishuEmoji, addReactionFeishu, buildMentionedCardContent, buildMentionedMessage, plugin as default, editMessageFeishu, extractMentionTargets, extractMessageBody, feishuPlugin, formatMentionAllForCard, formatMentionAllForText, formatMentionForCard, formatMentionForText, getMessageFeishu, isMentionForwardRequest, listReactionsFeishu, monitorFeishuProvider, probeFeishu, removeReactionFeishu, sendCardFeishu, sendFileFeishu, sendImageFeishu, sendMediaFeishu, sendMessageFeishu, updateCardFeishu, uploadFileFeishu, uploadImageFeishu };
