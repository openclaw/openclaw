import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";
import {
	duckdbExecOnFile,
	duckdbQueryOnFile,
	findDuckDBForObject,
	findObjectDir,
	resolveWorkspaceRoot,
} from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sqlEscape(s: string): string {
	return s.replace(/'/g, "''");
}

type ObjectContext = {
	objectName: string;
	objectId: string;
	dbFile: string;
	objectDir: string;
	workspaceRoot: string | null;
};

type EntryDocResolution = {
	absolute: string;
	workspaceRelative: string;
	title: string;
	source: "documents" | "legacy" | "generated";
};

type EntryFieldRow = {
	field_name: string;
	value: string | null;
};

function resolveObjectContext(objectName: string): ObjectContext | null {
	const dbFile = findDuckDBForObject(objectName);
	if (!dbFile) return null;

	const objects = duckdbQueryOnFile<{ id: string }>(
		dbFile,
		`SELECT id FROM objects WHERE name = '${sqlEscape(objectName)}' LIMIT 1`,
	);
	if (objects.length === 0) return null;

	const objectDir = findObjectDir(objectName);
	if (!objectDir) return null;

	return {
		objectName,
		objectId: objects[0].id,
		dbFile,
		objectDir,
		workspaceRoot: resolveWorkspaceRoot(),
	};
}

function toResolution(
	ctx: ObjectContext,
	absolute: string,
	title: string,
	source: EntryDocResolution["source"],
): EntryDocResolution {
	return {
		absolute,
		workspaceRelative: ctx.workspaceRoot
			? relative(ctx.workspaceRoot, absolute)
			: `${ctx.objectName}/${absolute.split("/").pop() ?? ""}`,
		title,
		source,
	};
}

function hasDocumentsEntryIdColumn(dbFile: string): boolean {
	const rows = duckdbQueryOnFile<{ cnt: number }>(
		dbFile,
		`SELECT COUNT(*) as cnt
		 FROM information_schema.columns
		 WHERE table_name = 'documents' AND column_name = 'entry_id'`,
	);
	return (rows[0]?.cnt ?? 0) > 0;
}

function ensureDocumentsEntryIdColumn(dbFile: string): void {
	duckdbExecOnFile(
		dbFile,
		`CREATE TABLE IF NOT EXISTS documents (
			id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
			title VARCHAR DEFAULT 'Untitled',
			icon VARCHAR,
			cover_image VARCHAR,
			file_path VARCHAR NOT NULL UNIQUE,
			parent_id VARCHAR REFERENCES documents(id),
			parent_object_id VARCHAR REFERENCES objects(id),
			entry_id VARCHAR REFERENCES entries(id),
			sort_order INTEGER DEFAULT 0,
			is_published BOOLEAN DEFAULT false,
			created_at TIMESTAMPTZ DEFAULT now(),
			updated_at TIMESTAMPTZ DEFAULT now()
		)`,
	);
	duckdbExecOnFile(dbFile, "ALTER TABLE documents ADD COLUMN IF NOT EXISTS entry_id VARCHAR");
}

function readEntryFieldMap(ctx: ObjectContext, entryId: string): Record<string, string> {
	const rows = duckdbQueryOnFile<EntryFieldRow>(
		ctx.dbFile,
		`SELECT f.name as field_name, ef.value
		 FROM entry_fields ef
		 JOIN fields f ON f.id = ef.field_id
		 WHERE ef.entry_id = '${sqlEscape(entryId)}'`,
	);
	const fields: Record<string, string> = {};
	for (const row of rows) {
		if (row.field_name && row.value) {
			fields[row.field_name] = row.value;
		}
	}
	return fields;
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return null;
}

function slugify(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-");
}

function extractYouTubeHandle(urlValue: string | undefined): string | null {
	const value = urlValue?.trim();
	if (!value) return null;

	try {
		const url = new URL(value.startsWith("http://") || value.startsWith("https://") ? value : `https://${value}`);
		const host = url.hostname.toLowerCase();
		if (!host.includes("youtube.com") && !host.includes("youtu.be")) return null;
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[0]?.startsWith("@")) {
			return parts[0].slice(1);
		}
		if ((parts[0] === "channel" || parts[0] === "c" || parts[0] === "user") && parts[1]) {
			return parts[1];
		}
	} catch {
		// ignore malformed URLs and fall through
	}

	const atMatch = value.match(/@([A-Za-z0-9._-]+)/);
	return atMatch?.[1] ?? null;
}

function pickDocumentTitle(ctx: ObjectContext, entryId: string, fields: Record<string, string>): string {
	return firstNonEmpty(
		fields["Document Title"],
		fields["Title"],
		fields["Channel Name"],
		fields["Creator Name"],
		fields["Full Name"],
		fields["Name"],
		fields["Company Name"],
		fields["Deal Name"],
		fields["Case Number"],
		fields["Invoice Number"],
		fields["Address"],
		fields["Email"],
	) ?? `${ctx.objectName} ${entryId}`;
}

function buildReadableStem(ctx: ObjectContext, fields: Record<string, string>, title: string): string {
	const explicitSlug = firstNonEmpty(fields["Document Slug"], fields["Slug"], fields["File Slug"]);
	if (explicitSlug) {
		return slugify(explicitSlug) || "entry";
	}

	const youtubeHandle = extractYouTubeHandle(fields["YouTube URL"]);
	if (youtubeHandle) {
		return `yt-${slugify(youtubeHandle)}`;
	}

	return slugify(title) || slugify(ctx.objectName) || "entry";
}

function lookupRegisteredDocument(
	ctx: ObjectContext,
	entryId: string,
): { file_path: string; title: string | null } | null {
	if (!hasDocumentsEntryIdColumn(ctx.dbFile)) return null;

	const rows = duckdbQueryOnFile<{ file_path: string; title: string | null }>(
		ctx.dbFile,
		`SELECT file_path, title
		 FROM documents
		 WHERE entry_id = '${sqlEscape(entryId)}'
		   AND parent_object_id = '${sqlEscape(ctx.objectId)}'
		 ORDER BY updated_at DESC
		 LIMIT 1`,
	);
	return rows[0] ?? null;
}

function lookupRegisteredEntryIdByPath(ctx: ObjectContext, workspaceRelativePath: string): string | null {
	if (!hasDocumentsEntryIdColumn(ctx.dbFile)) return null;

	const rows = duckdbQueryOnFile<{ entry_id: string | null }>(
		ctx.dbFile,
		`SELECT entry_id
		 FROM documents
		 WHERE file_path = '${sqlEscape(workspaceRelativePath)}'
		 LIMIT 1`,
	);
	return rows[0]?.entry_id ?? null;
}

function buildGeneratedResolution(ctx: ObjectContext, entryId: string): EntryDocResolution {
	const fields = readEntryFieldMap(ctx, entryId);
	const title = pickDocumentTitle(ctx, entryId, fields);
	const stem = buildReadableStem(ctx, fields, title);

	for (let i = 1; i <= 999; i++) {
		const filename = `${stem}-${String(i).padStart(3, "0")}.md`;
		const absolute = join(ctx.objectDir, filename);
		const resolution = toResolution(ctx, absolute, title, "generated");
		const ownerEntryId = lookupRegisteredEntryIdByPath(ctx, resolution.workspaceRelative);
		if (ownerEntryId === entryId) return resolution;
		if (ownerEntryId) continue;
		if (!existsSync(absolute)) return resolution;
	}

	return toResolution(ctx, join(ctx.objectDir, `${stem}-999.md`), title, "generated");
}

function resolveEntryMdPath(objectName: string, entryId: string): EntryDocResolution | null {
	const ctx = resolveObjectContext(objectName);
	if (!ctx) return null;

	const registered = lookupRegisteredDocument(ctx, entryId);
	if (registered) {
		const absolute = ctx.workspaceRoot && !registered.file_path.startsWith("/")
			? join(ctx.workspaceRoot, registered.file_path)
			: registered.file_path.startsWith("/")
				? registered.file_path
				: join(ctx.objectDir, registered.file_path.split("/").pop() ?? registered.file_path);
		return toResolution(
			ctx,
			absolute,
			registered.title?.trim() || registered.file_path.split("/").pop()?.replace(/\.mdx?$/, "") || entryId,
			"documents",
		);
	}

	const legacyAbsolute = join(ctx.objectDir, `${entryId}.md`);
	if (existsSync(legacyAbsolute)) {
		const fields = readEntryFieldMap(ctx, entryId);
		return toResolution(ctx, legacyAbsolute, pickDocumentTitle(ctx, entryId, fields), "legacy");
	}

	return buildGeneratedResolution(ctx, entryId);
}

function verifyEntryExists(ctx: ObjectContext, entryId: string): boolean {
	const rows = duckdbQueryOnFile<{ cnt: number }>(
		ctx.dbFile,
		`SELECT COUNT(*) as cnt
		 FROM entries
		 WHERE id = '${sqlEscape(entryId)}' AND object_id = '${sqlEscape(ctx.objectId)}'`,
	);
	return (rows[0]?.cnt ?? 0) > 0;
}

function registerEntryDocument(ctx: ObjectContext, entryId: string, resolved: EntryDocResolution): void {
	ensureDocumentsEntryIdColumn(ctx.dbFile);
	if (!hasDocumentsEntryIdColumn(ctx.dbFile)) return;

	const title = sqlEscape(resolved.title);
	const filePath = sqlEscape(resolved.workspaceRelative);
	const objectId = sqlEscape(ctx.objectId);
	const safeEntryId = sqlEscape(entryId);

	duckdbExecOnFile(
		ctx.dbFile,
		`UPDATE documents
		 SET title = '${title}',
		     file_path = '${filePath}',
		     parent_object_id = '${objectId}',
		     entry_id = '${safeEntryId}',
		     updated_at = now()
		 WHERE entry_id = '${safeEntryId}' AND parent_object_id = '${objectId}'`,
	);

	duckdbExecOnFile(
		ctx.dbFile,
		`UPDATE documents
		 SET title = '${title}',
		     parent_object_id = '${objectId}',
		     entry_id = '${safeEntryId}',
		     updated_at = now()
		 WHERE file_path = '${filePath}' AND (entry_id IS NULL OR entry_id = '${safeEntryId}')`,
	);

	duckdbExecOnFile(
		ctx.dbFile,
		`INSERT INTO documents (title, file_path, parent_object_id, entry_id)
		 SELECT '${title}', '${filePath}', '${objectId}', '${safeEntryId}'
		 WHERE NOT EXISTS (
		   SELECT 1 FROM documents
		   WHERE (entry_id = '${safeEntryId}' AND parent_object_id = '${objectId}')
		      OR file_path = '${filePath}'
		 )`,
	);
}

/**
 * GET /api/workspace/objects/[name]/entries/[id]/content
 * Returns { content: string, exists: boolean } for the entry's .md file.
 */
export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ name: string; id: string }> },
) {
	const { name, id } = await params;

	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
		return Response.json({ error: "Invalid object name" }, { status: 400 });
	}
	if (!id || id.length > 64) {
		return Response.json({ error: "Invalid entry ID" }, { status: 400 });
	}

	const ctx = resolveObjectContext(name);
	if (!ctx) {
		return Response.json({ content: "", exists: false, path: `${name}/${id}.md` });
	}

	const resolved = resolveEntryMdPath(name, id);
	if (!resolved) {
		return Response.json({ content: "", exists: false, path: `${name}/${id}.md` });
	}

	if (existsSync(resolved.absolute)) {
		const content = readFileSync(resolved.absolute, "utf-8");
		return Response.json({ content, exists: true, path: resolved.workspaceRelative });
	}

	return Response.json({ content: "", exists: false, path: resolved.workspaceRelative });
}

/**
 * PUT /api/workspace/objects/[name]/entries/[id]/content
 * Write the entry's .md file. Creates the file on first write.
 * Body: { content: string }
 */
export async function PUT(
	req: Request,
	{ params }: { params: Promise<{ name: string; id: string }> },
) {
	const { name, id } = await params;

	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
		return Response.json({ error: "Invalid object name" }, { status: 400 });
	}
	if (!id || id.length > 64) {
		return Response.json({ error: "Invalid entry ID" }, { status: 400 });
	}

	const ctx = resolveObjectContext(name);
	if (!ctx) {
		return Response.json({ error: "Object directory not found" }, { status: 404 });
	}

	if (!verifyEntryExists(ctx, id)) {
		return Response.json({ error: "Entry not found" }, { status: 404 });
	}

	const resolved = resolveEntryMdPath(name, id);
	if (!resolved) {
		return Response.json({ error: "Object directory not found" }, { status: 404 });
	}

	const body = await req.json();
	const content = typeof body.content === "string" ? body.content : "";

	if (!content.trim() && !existsSync(resolved.absolute)) {
		return Response.json({ ok: true, created: false, path: resolved.workspaceRelative });
	}

	const alreadyExists = existsSync(resolved.absolute);
	mkdirSync(dirname(resolved.absolute), { recursive: true });
	writeFileSync(resolved.absolute, content, "utf-8");
	registerEntryDocument(ctx, id, resolved);

	return Response.json({ ok: true, created: !alreadyExists, path: resolved.workspaceRelative });
}
