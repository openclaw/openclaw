import {
	duckdbExecOnFile,
	duckdbQueryOnFile,
	findDuckDBForObject,
	findObjectDir,
	pivotViewIdentifier,
	readObjectYaml,
	writeObjectYaml,
} from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sqlEscape(s: string): string {
	return s.replace(/'/g, "''");
}

const VALID_FIELD_TYPES = new Set([
	"text", "number", "email", "phone", "date", "boolean",
	"enum", "tags", "url", "richtext", "file", "action",
]);

/**
 * POST /api/workspace/objects/[name]/fields
 * Add a new field to an object.
 * Body: { name: string, type: string, enum_values?: string[], required?: boolean }
 */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ name: string }> },
) {
	const { name } = await params;

	if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
		return Response.json({ error: "Invalid object name" }, { status: 400 });
	}

	const dbFile = findDuckDBForObject(name);
	if (!dbFile) {
		return Response.json({ error: "DuckDB not found" }, { status: 404 });
	}

	const body = await req.json();
	const fieldName: string = body.name?.trim();
	const fieldType: string = body.type?.trim();
	const enumValues: string[] | undefined = body.enum_values;
	const required: boolean = body.required === true;

	if (!fieldName || fieldName.length === 0) {
		return Response.json({ error: "Field name is required" }, { status: 400 });
	}
	if (!fieldType || !VALID_FIELD_TYPES.has(fieldType)) {
		return Response.json(
			{ error: `Invalid field type. Must be one of: ${[...VALID_FIELD_TYPES].join(", ")}` },
			{ status: 400 },
		);
	}
	if (fieldType === "enum" && (!enumValues || !Array.isArray(enumValues) || enumValues.length === 0)) {
		return Response.json({ error: "enum_values required for enum fields" }, { status: 400 });
	}

	const objects = duckdbQueryOnFile<{ id: string }>(
		dbFile,
		`SELECT id FROM objects WHERE name = '${sqlEscape(name)}' LIMIT 1`,
	);
	if (objects.length === 0) {
		return Response.json({ error: `Object '${name}' not found` }, { status: 404 });
	}
	const objectId = objects[0].id;

	const duplicateCheck = duckdbQueryOnFile<{ cnt: number }>(
		dbFile,
		`SELECT COUNT(*) as cnt FROM fields WHERE object_id = '${sqlEscape(objectId)}' AND name = '${sqlEscape(fieldName)}'`,
	);
	if (duplicateCheck[0]?.cnt > 0) {
		return Response.json({ error: "A field with that name already exists" }, { status: 409 });
	}

	const maxOrder = duckdbQueryOnFile<{ max_order: number }>(
		dbFile,
		`SELECT COALESCE(MAX(sort_order), -1) as max_order FROM fields WHERE object_id = '${sqlEscape(objectId)}'`,
	);
	const sortOrder = (maxOrder[0]?.max_order ?? -1) + 1;

	const idRows = duckdbQueryOnFile<{ id: string }>(dbFile, "SELECT uuid()::VARCHAR as id");
	const fieldId = idRows[0]?.id;
	if (!fieldId) {
		return Response.json({ error: "Failed to generate field ID" }, { status: 500 });
	}

	const enumSql = fieldType === "enum" && enumValues
		? `, '${sqlEscape(JSON.stringify(enumValues))}'::JSON`
		: ", NULL";

	const actionConfig: unknown = body.action_config;
	const defaultValueSql = fieldType === "action" && actionConfig
		? `'${sqlEscape(JSON.stringify(actionConfig))}'`
		: "NULL";

	const ok = duckdbExecOnFile(
		dbFile,
		`INSERT INTO fields (id, object_id, name, type, required, sort_order, enum_values, default_value)
		 VALUES ('${sqlEscape(fieldId)}', '${sqlEscape(objectId)}', '${sqlEscape(fieldName)}', '${sqlEscape(fieldType)}', ${required}, ${sortOrder}${enumSql}, ${defaultValueSql})`,
	);

	if (!ok) {
		return Response.json({ error: "Failed to create field" }, { status: 500 });
	}

	regeneratePivotView(dbFile, name, objectId);
	updateObjectYamlFields(name, dbFile, objectId);

	if (fieldType === "action") {
		const { mkdirSync, existsSync } = await import("node:fs");
		const objDir = findObjectDir(name);
		if (objDir) {
			const actionsDir = `${objDir}/.actions`;
			if (!existsSync(actionsDir)) mkdirSync(actionsDir, { recursive: true });
		}
	}

	return Response.json({ ok: true, fieldId, name: fieldName, type: fieldType }, { status: 201 });
}

function regeneratePivotView(dbFile: string, objectName: string, objectId: string) {
	const fields = duckdbQueryOnFile<{ name: string }>(
		dbFile,
		`SELECT name FROM fields WHERE object_id = '${sqlEscape(objectId)}' AND type != 'action' ORDER BY sort_order`,
	);

	if (fields.length === 0) return;

	const fieldList = fields.map((f) => `'${sqlEscape(f.name)}'`).join(", ");
	const viewIdent = pivotViewIdentifier(objectName);

	duckdbExecOnFile(
		dbFile,
		`CREATE OR REPLACE VIEW ${viewIdent} AS
		 PIVOT (
		   SELECT e.id as entry_id, e.created_at, e.updated_at,
		          f.name as field_name, ef.value
		   FROM entries e
		   JOIN entry_fields ef ON ef.entry_id = e.id
		   JOIN fields f ON f.id = ef.field_id
		   WHERE e.object_id = '${sqlEscape(objectId)}'
		 ) ON field_name IN (${fieldList}) USING first(value)`,
	);
}

function updateObjectYamlFields(objectName: string, dbFile: string, objectId: string) {
	const dir = findObjectDir(objectName);
	if (!dir) return;

	const existing = readObjectYaml(dir) ?? {};

	const fields = duckdbQueryOnFile<{
		name: string;
		type: string;
		required: boolean;
		enum_values: string | null;
		default_value: string | null;
		sort_order: number;
	}>(
		dbFile,
		`SELECT name, type, required, enum_values, default_value, sort_order FROM fields WHERE object_id = '${sqlEscape(objectId)}' ORDER BY sort_order`,
	);

	const entryCount = duckdbQueryOnFile<{ cnt: number }>(
		dbFile,
		`SELECT COUNT(*) as cnt FROM entries WHERE object_id = '${sqlEscape(objectId)}'`,
	);

	writeObjectYaml(dir, {
		...existing,
		entry_count: entryCount[0]?.cnt ?? 0,
		fields: fields.map((f) => {
			const result: Record<string, unknown> = {
				name: f.name,
				type: f.type,
			};
			if (f.required) result.required = true;
			if (f.enum_values) {
				try { result.enum_values = JSON.parse(f.enum_values); } catch { /* ignore */ }
			}
			if (f.type === "action" && f.default_value) {
				try { result.action_config = JSON.parse(f.default_value); } catch { /* ignore */ }
			}
			return result;
		}),
	});
}
