import type { Dirent } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  resolveWorkspaceRoot,
  resolveOpenClawStateDir,
  getActiveWorkspaceName,
  parseSimpleYaml,
  duckdbQueryAllAsync,
  isDatabaseFile,
} from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type TreeNode = {
  name: string;
  path: string; // relative to workspace root (or ~skills/ for virtual nodes)
  type: "object" | "document" | "folder" | "file" | "database" | "report" | "app";
  icon?: string;
  defaultView?: "table" | "kanban";
  children?: TreeNode[];
  /** Virtual nodes live outside the main workspace. */
  virtual?: boolean;
  /** True when the entry is a symbolic link. */
  symlink?: boolean;
  /** App manifest metadata (only for type: "app"). */
  appManifest?: {
    name: string;
    description?: string;
    icon?: string;
    version?: string;
    entry?: string;
    runtime?: string;
  };
};

type DbObject = {
  name: string;
  icon?: string;
  default_view?: string;
};

/** Read .object.yaml metadata from a directory if it exists. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Read .object.yaml metadata from a directory if it exists. */
async function readObjectMeta(
  dirPath: string,
): Promise<{ icon?: string; defaultView?: string } | null> {
  const yamlPath = join(dirPath, ".object.yaml");
  if (!await pathExists(yamlPath)) {return null;}

  try {
    const content = await readFile(yamlPath, "utf-8");
    const parsed = parseSimpleYaml(content);
    return {
      icon: parsed.icon as string | undefined,
      defaultView: parsed.default_view as string | undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Query ALL discovered DuckDB files for objects so we can identify object
 * directories even when .object.yaml files are missing.
 * Shallower databases win on name conflicts (parent priority).
 */
async function loadDbObjects(): Promise<Map<string, DbObject>> {
  const map = new Map<string, DbObject>();
  const rows = await duckdbQueryAllAsync<DbObject & { name: string }>(
    "SELECT name, icon, default_view FROM objects",
    "name",
  );
  for (const row of rows) {
    map.set(row.name, row);
  }
  return map;
}

/** Resolve a dirent's effective type, following symlinks to their target. */
async function resolveEntryType(
  entry: Dirent,
  absPath: string,
): Promise<"directory" | "file" | null> {
  if (entry.isDirectory()) {return "directory";}
  if (entry.isFile()) {return "file";}
  if (entry.isSymbolicLink()) {
    try {
      const st = await stat(absPath);
      if (st.isDirectory()) {return "directory";}
      if (st.isFile()) {return "file";}
    } catch {
      // Broken symlink -- skip
    }
  }
  return null;
}

/** Read .dench.yaml manifest from a .dench.app directory. */
async function readAppManifest(
  dirPath: string,
): Promise<TreeNode["appManifest"] | null> {
  const yamlPath = join(dirPath, ".dench.yaml");
  if (!await pathExists(yamlPath)) return null;

  try {
    const content = await readFile(yamlPath, "utf-8");
    const parsed = parseSimpleYaml(content);
    return {
      name: (parsed.name as string) || dirPath.split("/").pop()?.replace(/\.dench\.app$/, "") || "App",
      description: parsed.description as string | undefined,
      icon: parsed.icon as string | undefined,
      version: parsed.version as string | undefined,
      entry: (parsed.entry as string) || "index.html",
      runtime: (parsed.runtime as string) || "static",
    };
  } catch {
    return null;
  }
}

/** Recursively build a tree from a workspace directory. */
async function buildTree(
  absDir: string,
  relativeBase: string,
  dbObjects: Map<string, DbObject>,
  showHidden = false,
): Promise<TreeNode[]> {
  const nodes: TreeNode[] = [];

  let entries: Dirent[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return nodes;
  }

  const filtered = entries.filter((e) => {
    // .object.yaml is always needed for metadata; also shown as a node when showHidden is on
    if (e.name === ".object.yaml") {return true;}
    if (e.name.startsWith(".")) {return showHidden;}
    return true;
  });

  // Sort: directories first, then files, alphabetical within each group
  const typedEntries = await Promise.all(filtered.map(async (entry) => {
    const absPath = join(absDir, entry.name);
    const effectiveType = await resolveEntryType(entry, absPath);
    return { entry, absPath, effectiveType };
  }));

  const sorted = typedEntries.toSorted((a, b) => {
    const dirA = a.effectiveType === "directory";
    const dirB = b.effectiveType === "directory";
    if (dirA && !dirB) {return -1;}
    if (!dirA && dirB) {return 1;}
    return a.entry.name.localeCompare(b.entry.name);
  });

  for (const { entry, absPath, effectiveType } of sorted) {
    // .object.yaml is consumed for metadata; only show it as a visible node when revealing hidden files
    if (entry.name === ".object.yaml" && !showHidden) {continue;}
    const relPath = relativeBase
      ? `${relativeBase}/${entry.name}`
      : entry.name;

    const isSymlink = entry.isSymbolicLink();

    if (effectiveType === "directory") {
      // Detect .dench.app folders -- treat as app nodes
      if (entry.name.endsWith(".dench.app")) {
        const manifest = await readAppManifest(absPath);
        const displayName = manifest?.name || entry.name.replace(/\.dench\.app$/, "");
        const children = showHidden ? await buildTree(absPath, relPath, dbObjects, showHidden) : undefined;
        nodes.push({
          name: displayName,
          path: relPath,
          type: "app",
          icon: manifest?.icon,
          appManifest: manifest ?? { name: displayName, entry: "index.html", runtime: "static" },
          ...(children && children.length > 0 && { children }),
          ...(isSymlink && { symlink: true }),
        });
        continue;
      }

      const objectMeta = await readObjectMeta(absPath);
      const dbObject = dbObjects.get(entry.name);
      const children = await buildTree(absPath, relPath, dbObjects, showHidden);

      if (objectMeta || dbObject) {
        nodes.push({
          name: entry.name,
          path: relPath,
          type: "object",
          icon: objectMeta?.icon ?? dbObject?.icon,
          defaultView:
            ((objectMeta?.defaultView ?? dbObject?.default_view) as
              | "table"
              | "kanban") ?? "table",
          children: children.length > 0 ? children : undefined,
          ...(isSymlink && { symlink: true }),
        });
      } else {
        nodes.push({
          name: entry.name,
          path: relPath,
          type: "folder",
          children: children.length > 0 ? children : undefined,
          ...(isSymlink && { symlink: true }),
        });
      }
    } else if (effectiveType === "file") {
      const ext = entry.name.split(".").pop()?.toLowerCase();
      const isReport = entry.name.endsWith(".report.json");
      const isDocument = ext === "md" || ext === "mdx";
      const isDatabase = isDatabaseFile(entry.name);

      nodes.push({
        name: entry.name,
        path: relPath,
        type: isReport ? "report" : isDatabase ? "database" : isDocument ? "document" : "file",
        ...(isSymlink && { symlink: true }),
      });
    }
  }

  return nodes;
}


export async function GET(req: Request) {
  const url = new URL(req.url);
  const showHidden = url.searchParams.get("showHidden") === "1";

  const openclawDir = resolveOpenClawStateDir();
  const workspace = getActiveWorkspaceName();
  const root = resolveWorkspaceRoot();
  if (!root) {
    const tree: TreeNode[] = [];
    return Response.json({ tree, exists: false, workspaceRoot: null, openclawDir, workspace });
  }

  const dbObjects = await loadDbObjects();

  const tree = await buildTree(root, "", dbObjects, showHidden);

  return Response.json({ tree, exists: true, workspaceRoot: root, openclawDir, workspace });
}
