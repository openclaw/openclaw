import { duckdbQuery, duckdbPath } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ObjectRow = {
	id: string;
	name: string;
	display_field?: string;
};

type FieldRow = {
	id: string;
	name: string;
	type: string;
};

function sqlEscape(s: string): string {
	return s.replace(/'/g, "''");
}

function resolveDisplayField(
	obj: ObjectRow,
	fields: FieldRow[],
): string {
	if (obj.display_field) {return obj.display_field;}
	const nameField = fields.find(
		(f) => /\bname\b/i.test(f.name) || /\btitle\b/i.test(f.name),
	);
	if (nameField) {return nameField.name;}
	const textField = fields.find((f) => f.type === "text");
	if (textField) {return textField.name;}
	return fields[0]?.name ?? "id";
}

/**
 * GET /api/workspace/objects/[name]/entries/options
 * Returns lightweight { options: [{ id, label }] } for relation dropdowns.
 * Supports optional ?q= search parameter.
 */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ name: string }> },
) {
	const { name } = await params;

	if (!duckdbPath()) {
		return Response.json({ error: "DuckDB not found" }, { status: 404 });
	}

	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
		return Response.json({ error: "Invalid object name" }, { status: 400 });
	}

	const objects = duckdbQuery<ObjectRow>(
		`SELECT * FROM objects WHERE name = '${sqlEscape(name)}' LIMIT 1`,
	);
	if (objects.length === 0) {
		return Response.json({ error: `Object '${name}' not found` }, { status: 404 });
	}
	const obj = objects[0];

	const fields = duckdbQuery<FieldRow>(
		`SELECT * FROM fields WHERE object_id = '${sqlEscape(obj.id)}' ORDER BY sort_order`,
	);
	const displayFieldName = resolveDisplayField(obj, fields);

	// Optional search filter
	const url = new URL(req.url);
	const query = url.searchParams.get("q")?.trim() ?? "";

	// Fetch entries with their display field value
	const rows = duckdbQuery<{ entry_id: string; label: string | null }>(
		`SELECT e.id as entry_id, ef.value as label
		 FROM entries e
		 LEFT JOIN entry_fields ef ON ef.entry_id = e.id
		 LEFT JOIN fields f ON f.id = ef.field_id AND f.name = '${sqlEscape(displayFieldName)}'
		 WHERE e.object_id = '${sqlEscape(obj.id)}'
		 ${query ? `AND (ef.value IS NOT NULL AND LOWER(ef.value) LIKE '%${sqlEscape(query.toLowerCase())}%')` : ""}
		 ORDER BY ef.value ASC NULLS LAST
		 LIMIT 200`,
	);

	const options = rows.map((r) => ({
		id: r.entry_id,
		label: r.label || r.entry_id,
	}));

	return Response.json({ options, displayField: displayFieldName });
}
