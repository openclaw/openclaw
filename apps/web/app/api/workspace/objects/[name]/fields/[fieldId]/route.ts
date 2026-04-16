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

/**
 * PATCH /api/workspace/objects/[name]/fields/[fieldId]
 * Rename a field.
 * Body: { name: string }
 */
export async function PATCH(
	req: Request,
	{
		params,
	}: { params: Promise<{ name: string; fieldId: string }> },
) {
	const { name, fieldId } = await params;

	if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
		return Response.json(
			{ error: "Invalid object name" },
			{ status: 400 },
		);
	}

	const dbFile = findDuckDBForObject(name);
	if (!dbFile) {
		return Response.json(
			{ error: "DuckDB not found" },
			{ status: 404 },
		);
	}

	const body = await req.json();
	const newName: string = body.name;

	if (
		!newName ||
		typeof newName !== "string" ||
		newName.trim().length === 0
	) {
		return Response.json(
			{ error: "Name is required" },
			{ status: 400 },
		);
	}

	// Validate object exists
	const objects = duckdbQueryOnFile<{ id: string }>(dbFile,
		`SELECT id FROM objects WHERE name = '${sqlEscape(name)}' LIMIT 1`,
	);
	if (objects.length === 0) {
		return Response.json(
			{ error: `Object '${name}' not found` },
			{ status: 404 },
		);
	}
	const objectId = objects[0].id;

	// Validate field exists and belongs to this object
	const fieldExists = duckdbQueryOnFile<{ cnt: number }>(dbFile,
		`SELECT COUNT(*) as cnt FROM fields WHERE id = '${sqlEscape(fieldId)}' AND object_id = '${sqlEscape(objectId)}'`,
	);
	if (!fieldExists[0] || fieldExists[0].cnt === 0) {
		return Response.json(
			{ error: "Field not found" },
			{ status: 404 },
		);
	}

	// Check for duplicate name
	const duplicateCheck = duckdbQueryOnFile<{ cnt: number }>(dbFile,
		`SELECT COUNT(*) as cnt FROM fields WHERE object_id = '${sqlEscape(objectId)}' AND name = '${sqlEscape(newName.trim())}' AND id != '${sqlEscape(fieldId)}'`,
	);
	if (duplicateCheck[0]?.cnt > 0) {
		return Response.json(
			{ error: "A field with that name already exists" },
			{ status: 409 },
		);
	}

	const ok = duckdbExecOnFile(dbFile,
		`UPDATE fields SET name = '${sqlEscape(newName.trim())}' WHERE id = '${sqlEscape(fieldId)}'`,
	);

	if (!ok) {
		return Response.json(
			{ error: "Failed to rename field" },
			{ status: 500 },
		);
	}

	regeneratePivotView(dbFile, name, objectId);
	updateObjectYamlFields(name, dbFile, objectId);

	return Response.json({ ok: true });
}

/**
 * DELETE /api/workspace/objects/[name]/fields/[fieldId]
 * Remove a field and all its entry data.
 */
export async function DELETE(
	_req: Request,
	{
		params,
	}: { params: Promise<{ name: string; fieldId: string }> },
) {
	const { name, fieldId } = await params;

	if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
		return Response.json(
			{ error: "Invalid object name" },
			{ status: 400 },
		);
	}

	const dbFile = findDuckDBForObject(name);
	if (!dbFile) {
		return Response.json(
			{ error: "DuckDB not found" },
			{ status: 404 },
		);
	}

	const objects = duckdbQueryOnFile<{ id: string }>(dbFile,
		`SELECT id FROM objects WHERE name = '${sqlEscape(name)}' LIMIT 1`,
	);
	if (objects.length === 0) {
		return Response.json(
			{ error: `Object '${name}' not found` },
			{ status: 404 },
		);
	}
	const objectId = objects[0].id;

	const fieldExists = duckdbQueryOnFile<{ cnt: number }>(dbFile,
		`SELECT COUNT(*) as cnt FROM fields WHERE id = '${sqlEscape(fieldId)}' AND object_id = '${sqlEscape(objectId)}'`,
	);
	if (!fieldExists[0] || fieldExists[0].cnt === 0) {
		return Response.json(
			{ error: "Field not found" },
			{ status: 404 },
		);
	}

	const ok1 = duckdbExecOnFile(dbFile,
		`DELETE FROM entry_fields WHERE field_id = '${sqlEscape(fieldId)}'`,
	);
	const ok2 = duckdbExecOnFile(dbFile,
		`DELETE FROM fields WHERE id = '${sqlEscape(fieldId)}'`,
	);

	if (!ok1 || !ok2) {
		return Response.json(
			{ error: "Failed to delete field" },
			{ status: 500 },
		);
	}

	regeneratePivotView(dbFile, name, objectId);
	updateObjectYamlFields(name, dbFile, objectId);

	return Response.json({ ok: true });
}

/* ─── Shared helpers ─── */

function regeneratePivotView(dbFile: string, objectName: string, objectId: string) {
	const fields = duckdbQueryOnFile<{ name: string }>(
		dbFile,
		`SELECT name FROM fields WHERE object_id = '${sqlEscape(objectId)}' AND type != 'action' ORDER BY sort_order`,
	);

	const viewIdent = pivotViewIdentifier(objectName);

	if (fields.length === 0) {
		duckdbExecOnFile(dbFile, `DROP VIEW IF EXISTS ${viewIdent}`);
		return;
	}

	const fieldList = fields.map((f) => `'${sqlEscape(f.name)}'`).join(", ");

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
