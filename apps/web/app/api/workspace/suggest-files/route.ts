import { readdirSync, readFileSync, existsSync, type Dirent } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { homedir } from "node:os";
import {
	resolveWorkspaceRoot,
	duckdbQueryAllAsync,
	discoverDuckDBPaths,
	duckdbQueryOnFileAsync,
	parseSimpleYaml,
} from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SuggestItem = {
	name: string;
	path: string;
	type: "folder" | "file" | "document" | "database" | "object" | "entry";
	/** Icon hint (emoji) for objects/entries */
	icon?: string;
	/** Object name that owns this entry */
	objectName?: string;
	/** DB entry ID */
	entryId?: string;
};

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	".Trash",
	"__pycache__",
	".cache",
	".DS_Store",
]);

/** List entries in a directory, sorted folders-first then alphabetically. */
function listDir(absDir: string, filter?: string): SuggestItem[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(absDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const lowerFilter = filter?.toLowerCase();

	const sorted = entries
		.filter((e) => !e.name.startsWith("."))
		.filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
		.filter((e) => !lowerFilter || e.name.toLowerCase().includes(lowerFilter))
		.toSorted((a, b) => {
			if (a.isDirectory() && !b.isDirectory()) {return -1;}
			if (!a.isDirectory() && b.isDirectory()) {return 1;}
			return a.name.localeCompare(b.name);
		});

	const items: SuggestItem[] = [];
	for (const entry of sorted) {
		if (items.length >= 30) {break;}
		const absPath = join(absDir, entry.name);

		if (entry.isDirectory()) {
			items.push({ name: entry.name, path: absPath, type: "folder" });
		} else if (entry.isFile()) {
			const ext = entry.name.split(".").pop()?.toLowerCase();
			const isDocument = ext === "md" || ext === "mdx";
			const isDatabase =
				ext === "duckdb" || ext === "sqlite" || ext === "sqlite3" || ext === "db";
			items.push({
				name: entry.name,
				path: absPath,
				type: isDatabase ? "database" : isDocument ? "document" : "file",
			});
		}
	}
	return items;
}

/** Recursively search for files matching a query, up to a limit. */
function searchFiles(
	absDir: string,
	query: string,
	results: SuggestItem[],
	maxResults: number,
	depth = 0,
): void {
	if (depth > 6 || results.length >= maxResults) {return;}

	let entries: Dirent[];
	try {
		entries = readdirSync(absDir, { withFileTypes: true });
	} catch {
		return;
	}

	const lowerQuery = query.toLowerCase();

	for (const entry of entries) {
		if (results.length >= maxResults) {return;}
		if (entry.name.startsWith(".")) {continue;}
		if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {continue;}

		const absPath = join(absDir, entry.name);

		if (entry.isFile() && entry.name.toLowerCase().includes(lowerQuery)) {
			const ext = entry.name.split(".").pop()?.toLowerCase();
			const isDocument = ext === "md" || ext === "mdx";
			const isDatabase =
				ext === "duckdb" || ext === "sqlite" || ext === "sqlite3" || ext === "db";
			results.push({
				name: entry.name,
				path: absPath,
				type: isDatabase ? "database" : isDocument ? "document" : "file",
			});
		} else if (
			entry.isDirectory() &&
			entry.name.toLowerCase().includes(lowerQuery)
		) {
			results.push({ name: entry.name, path: absPath, type: "folder" });
		}

		if (entry.isDirectory()) {
			searchFiles(absPath, query, results, maxResults, depth + 1);
		}
	}
}

/**
 * Resolve a user-typed path query into a directory to list and an optional filter.
 *
 * Examples:
 *   "../"        → list parent of workspace root
 *   "/"          → list filesystem root
 *   "~/"         → list home dir
 *   "~/Doc"      → list home dir, filter "Doc"
 *   "src/utils"  → list <workspace>/src, filter "utils"
 *   "foo.ts"     → search by filename
 */
function resolvePath(
	raw: string,
	workspaceRoot: string,
): { dir: string; filter?: string } | null {
	const home = homedir();

	if (raw.startsWith("~/")) {
		const rest = raw.slice(2);
		if (!rest || rest.endsWith("/")) {
			// List the directory
			const dir = rest ? resolve(home, rest) : home;
			return { dir };
		}
		// Has a trailing segment → list parent, filter by segment
		const dir = resolve(home, dirname(rest));
		return { dir, filter: basename(rest) };
	}

	if (raw.startsWith("/")) {
		if (raw === "/") {return { dir: "/" };}
		if (raw.endsWith("/")) {
			return { dir: resolve(raw) };
		}
		const dir = dirname(resolve(raw));
		return { dir, filter: basename(raw) };
	}

	if (raw.startsWith("../") || raw === "..") {
		const resolved = resolve(workspaceRoot, raw);
		if (raw.endsWith("/") || raw === "..") {
			return { dir: resolved };
		}
		return { dir: dirname(resolved), filter: basename(resolved) };
	}

	if (raw.startsWith("./")) {
		const rest = raw.slice(2);
		if (!rest || rest.endsWith("/")) {
			const dir = rest ? resolve(workspaceRoot, rest) : workspaceRoot;
			return { dir };
		}
		const dir = resolve(workspaceRoot, dirname(rest));
		return { dir, filter: basename(rest) };
	}

	// Contains a slash → treat as relative path from workspace
	if (raw.includes("/")) {
		if (raw.endsWith("/")) {
			return { dir: resolve(workspaceRoot, raw) };
		}
		const dir = resolve(workspaceRoot, dirname(raw));
		return { dir, filter: basename(raw) };
	}

	// No path separator → this is a filename search
	return null;
}

// ---------------------------------------------------------------------------
// DuckDB object & entry search
// ---------------------------------------------------------------------------

type ObjectRow = {
	id: string;
	name: string;
	description?: string;
	icon?: string;
	display_field?: string;
};

type FieldRow = {
	id: string;
	name: string;
	type: string;
	sort_order?: number;
};

function sqlEscape(s: string): string {
	return s.replace(/'/g, "''");
}

function resolveDisplayField(obj: ObjectRow, fields: FieldRow[]): string {
	if (obj.display_field) {return obj.display_field;}
	const nameField = fields.find(
		(f) => /\bname\b/i.test(f.name) || /\btitle\b/i.test(f.name),
	);
	if (nameField) {return nameField.name;}
	const textField = fields.find((f) => f.type === "text");
	if (textField) {return textField.name;}
	return fields[0]?.name ?? "id";
}

/** Read icon from .object.yaml if present. */
function readObjectIcon(workspaceRoot: string, objName: string): string | undefined {
	// Walk workspace to find a folder matching objName that has .object.yaml
	function walk(dir: string, depth: number): string | undefined {
		if (depth > 4) {return undefined;}
		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory() || entry.name.startsWith(".")) {continue;}
				if (entry.name === objName) {
					const yamlPath = join(dir, entry.name, ".object.yaml");
					if (existsSync(yamlPath)) {
						const parsed = parseSimpleYaml(readFileSync(yamlPath, "utf-8"));
						if (parsed.icon) {return String(parsed.icon);}
					}
				}
				const found = walk(join(dir, entry.name), depth + 1);
				if (found) {return found;}
			}
		} catch { /* skip */ }
		return undefined;
	}
	return walk(workspaceRoot, 0);
}

/** Search objects by name (case-insensitive substring). */
async function searchObjects(
	query: string,
	workspaceRoot: string,
	max: number,
): Promise<SuggestItem[]> {
	const sql = query
		? `SELECT * FROM objects WHERE LOWER(name) LIKE LOWER('%${sqlEscape(query)}%') ORDER BY name LIMIT ${max}`
		: `SELECT * FROM objects ORDER BY name LIMIT ${max}`;
	const objects = await duckdbQueryAllAsync<ObjectRow>(sql, "name");

	const items: SuggestItem[] = [];
	for (const obj of objects) {
		const yamlIcon = readObjectIcon(workspaceRoot, obj.name);
		items.push({
			name: obj.name,
			path: `workspace:object:${obj.name}`,
			type: "object",
			icon: yamlIcon ?? obj.icon,
		});
	}
	return items;
}

/** Safely convert an unknown DB value to a display string. */
function dbStr(val: unknown): string {
	if (val == null) {return "";}
	if (typeof val === "object") {return JSON.stringify(val);}
	return String(val as string | number | boolean);
}

/**
 * Search entries across all objects using a single UNION ALL query per DB.
 * Each object's pivot view (v_<name>) is searched by display field with ILIKE.
 * This avoids spawning N DuckDB CLI processes per object.
 */
async function searchEntries(
	query: string,
	max: number,
): Promise<SuggestItem[]> {
	const dbPaths = discoverDuckDBPaths();
	if (dbPaths.length === 0 || !query) {return [];}

	const items: SuggestItem[] = [];
	const seenObjects = new Set<string>();
	const likePattern = `%${sqlEscape(query)}%`;

	for (const dbPath of dbPaths) {
		if (items.length >= max) {break;}

		// Step 1: get objects + display fields in a single query
		type ObjFieldRow = ObjectRow & { field_name: string; field_type: string };
		const objFields = await duckdbQueryOnFileAsync<ObjFieldRow>(
			dbPath,
			`SELECT o.*, f.name as field_name, f.type as field_type
			 FROM objects o
			 LEFT JOIN fields f ON f.object_id = o.id
			 ORDER BY o.name, f.sort_order`,
		);

		// Group fields by object and resolve display fields
		const objectMap = new Map<string, { obj: ObjectRow; displayField: string }>();
		const fieldsByObj = new Map<string, FieldRow[]>();
		for (const row of objFields) {
			if (seenObjects.has(row.name)) {continue;}
			if (!fieldsByObj.has(row.id)) {fieldsByObj.set(row.id, []);}
			if (row.field_name) {
				fieldsByObj.get(row.id)!.push({
					id: row.id,
					name: row.field_name,
					type: row.field_type,
				});
			}
			if (!objectMap.has(row.name)) {
				const fields = fieldsByObj.get(row.id) ?? [];
				objectMap.set(row.name, {
					obj: row,
					displayField: resolveDisplayField(row, fields),
				});
			}
		}

		// Re-resolve display fields now that all fields are collected
		for (const [name, entry] of objectMap) {
			const fields = fieldsByObj.get(entry.obj.id) ?? [];
			entry.displayField = resolveDisplayField(entry.obj, fields);
			seenObjects.add(name);
		}

		if (objectMap.size === 0) {continue;}

		// Step 2: build a single UNION ALL query searching all pivot views
		// Wrap each SELECT in parens so per-view LIMIT is valid DuckDB syntax
		const unionParts: string[] = [];
		for (const [name, { displayField }] of objectMap) {
			const safeDisplay = sqlEscape(displayField);
			unionParts.push(
				`(SELECT '${sqlEscape(name)}' as _obj_name, entry_id, "${safeDisplay}" as _display
				  FROM v_${name}
				  WHERE LOWER(CAST("${safeDisplay}" AS VARCHAR)) LIKE LOWER('${likePattern}')
				  LIMIT ${max})`,
			);
		}

		if (unionParts.length === 0) {continue;}

		type EntryHit = { _obj_name: string; entry_id: string; _display: string };
		const hits = await duckdbQueryOnFileAsync<EntryHit>(
			dbPath,
			`${unionParts.join(" UNION ALL ")} LIMIT ${max}`,
		);

		for (const hit of hits) {
			if (items.length >= max) {return items;}
			if (!hit.entry_id || !hit._display) {continue;}
			const objInfo = objectMap.get(hit._obj_name);
			items.push({
				name: String(hit._display),
				path: `workspace:entry:${hit._obj_name}:${hit.entry_id}`,
				type: "entry",
				icon: objInfo?.obj.icon,
				objectName: hit._obj_name,
				entryId: hit.entry_id,
			});
		}
	}

	return items;
}

export async function GET(req: Request) {
	const url = new URL(req.url);
	const pathQuery = url.searchParams.get("path");
	const searchQuery = url.searchParams.get("q");
	const workspaceRoot = resolveWorkspaceRoot() ?? homedir();

	// Search mode: find files, objects, and entries by name
	if (searchQuery) {
		// File search: workspace only (skip expensive home dir traversal)
		const fileResults: SuggestItem[] = [];
		searchFiles(workspaceRoot, searchQuery, fileResults, 15);

		// DuckDB search: objects and entries (sequential to avoid lock contention)
		const objectResults = await searchObjects(searchQuery, workspaceRoot, 10);
		const entryResults = await searchEntries(searchQuery, 15);

		// Deduplicate: if an object matches, remove the duplicate folder
		const objectNames = new Set(objectResults.map((o) => o.name));
		const dedupedFiles = fileResults.filter(
			(f) => !(f.type === "folder" && objectNames.has(f.name)),
		);

		// Merge: objects first, then entries, then files
		const items = [...objectResults, ...entryResults, ...dedupedFiles].slice(0, 30);
		return Response.json({ items });
	}

	// Browse mode: resolve path and list directory
	if (pathQuery) {
		const resolved = resolvePath(pathQuery, workspaceRoot);
		if (!resolved) {
			const results: SuggestItem[] = [];
			searchFiles(workspaceRoot, pathQuery, results, 20);
			return Response.json({ items: results });
		}
		const items = listDir(resolved.dir, resolved.filter);
		return Response.json({ items });
	}

	// Default: list workspace root + all objects
	const fileItems = listDir(workspaceRoot);
	const objectItems = await searchObjects("", workspaceRoot, 20);
	// Deduplicate: if an object also appears as a folder, keep the object version
	const objectNames = new Set(objectItems.map((o) => o.name));
	const dedupedFiles = fileItems.filter(
		(f) => !(f.type === "folder" && objectNames.has(f.name)),
	);
	return Response.json({ items: [...objectItems, ...dedupedFiles] });
}
