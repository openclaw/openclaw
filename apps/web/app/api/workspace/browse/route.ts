import { readdirSync, type Dirent } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { resolveDenchRoot } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type BrowseNode = {
	name: string;
	path: string; // absolute path
	type: "folder" | "file" | "document" | "database";
	children?: BrowseNode[];
};

/** Directories to skip when browsing the filesystem. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".Trash", "__pycache__", ".cache"]);

/** Build a depth-limited tree from an absolute directory. */
function buildBrowseTree(
	absDir: string,
	maxDepth: number,
	currentDepth = 0,
): BrowseNode[] {
	if (currentDepth >= maxDepth) {return [];}

	let entries: Dirent[];
	try {
		entries = readdirSync(absDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const sorted = entries
		.filter((e) => !e.name.startsWith("."))
		.filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
		.toSorted((a, b) => {
			if (a.isDirectory() && !b.isDirectory()) {return -1;}
			if (!a.isDirectory() && b.isDirectory()) {return 1;}
			return a.name.localeCompare(b.name);
		});

	const nodes: BrowseNode[] = [];

	for (const entry of sorted) {
		const absPath = join(absDir, entry.name);

		if (entry.isDirectory()) {
			const children = buildBrowseTree(absPath, maxDepth, currentDepth + 1);
			nodes.push({
				name: entry.name,
				path: absPath,
				type: "folder",
				children: children.length > 0 ? children : undefined,
			});
		} else if (entry.isFile()) {
			const ext = entry.name.split(".").pop()?.toLowerCase();
			const isDocument = ext === "md" || ext === "mdx";
			const isDatabase = ext === "duckdb" || ext === "sqlite" || ext === "sqlite3" || ext === "db";

			nodes.push({
				name: entry.name,
				path: absPath,
				type: isDatabase ? "database" : isDocument ? "document" : "file",
			});
		}
	}

	return nodes;
}

export async function GET(req: Request) {
	const url = new URL(req.url);
	let dir = url.searchParams.get("dir");

	// Default to the dench workspace root
	if (!dir) {
		dir = resolveDenchRoot();
	}

	if (!dir) {
		return Response.json(
			{ entries: [], currentDir: "/", parentDir: null },
		);
	}

	// Resolve and normalize the directory path
	const resolved = resolve(dir);

	const entries = buildBrowseTree(resolved, 3);
	const parentDir = resolved === "/" ? null : dirname(resolved);

	return Response.json({
		entries,
		currentDir: resolved,
		parentDir,
	});
}
