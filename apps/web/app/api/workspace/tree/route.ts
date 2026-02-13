import { readdirSync, readFileSync, existsSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveDenchRoot, parseSimpleYaml, duckdbQuery, isDatabaseFile } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type TreeNode = {
  name: string;
  path: string; // relative to dench/ (or ~skills/, ~memories/, ~workspace/ for virtual nodes)
  type: "object" | "document" | "folder" | "file" | "database" | "report";
  icon?: string;
  defaultView?: "table" | "kanban";
  children?: TreeNode[];
  /** Virtual nodes live outside the dench workspace (e.g. Skills, Memories). */
  virtual?: boolean;
};

type DbObject = {
  name: string;
  icon?: string;
  default_view?: string;
};

/** Read .object.yaml metadata from a directory if it exists. */
function readObjectMeta(
  dirPath: string,
): { icon?: string; defaultView?: string } | null {
  const yamlPath = join(dirPath, ".object.yaml");
  if (!existsSync(yamlPath)) {return null;}

  try {
    const content = readFileSync(yamlPath, "utf-8");
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
 * Query DuckDB for all objects so we can identify object directories
 * even when .object.yaml files are missing.
 */
function loadDbObjects(): Map<string, DbObject> {
  const map = new Map<string, DbObject>();
  const rows = duckdbQuery<DbObject>(
    "SELECT name, icon, default_view FROM objects",
  );
  for (const row of rows) {
    map.set(row.name, row);
  }
  return map;
}

/** Recursively build a tree from a workspace directory. */
function buildTree(
  absDir: string,
  relativeBase: string,
  dbObjects: Map<string, DbObject>,
): TreeNode[] {
  const nodes: TreeNode[] = [];

  let entries: Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return nodes;
  }

  // Sort: directories first, then files, alphabetical within each group
  const sorted = entries
    .filter((e) => !e.name.startsWith(".") || e.name === ".object.yaml")
    .toSorted((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) {return -1;}
      if (!a.isDirectory() && b.isDirectory()) {return 1;}
      return a.name.localeCompare(b.name);
    });

  for (const entry of sorted) {
    // Skip hidden files except .object.yaml (but don't list it as a node)
    if (entry.name === ".object.yaml") {continue;}
    if (entry.name.startsWith(".")) {continue;}

    const absPath = join(absDir, entry.name);
    const relPath = relativeBase
      ? `${relativeBase}/${entry.name}`
      : entry.name;

    if (entry.isDirectory()) {
      const objectMeta = readObjectMeta(absPath);
      const dbObject = dbObjects.get(entry.name);
      const children = buildTree(absPath, relPath, dbObjects);

      if (objectMeta || dbObject) {
        // This directory represents a CRM object (from .object.yaml OR DuckDB)
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
        });
      } else {
        // Regular folder
        nodes.push({
          name: entry.name,
          path: relPath,
          type: "folder",
          children: children.length > 0 ? children : undefined,
        });
      }
    } else if (entry.isFile()) {
      const ext = entry.name.split(".").pop()?.toLowerCase();
      const isReport = entry.name.endsWith(".report.json");
      const isDocument = ext === "md" || ext === "mdx";
      const isDatabase = isDatabaseFile(entry.name);

      nodes.push({
        name: entry.name,
        path: relPath,
        type: isReport ? "report" : isDatabase ? "database" : isDocument ? "document" : "file",
      });
    }
  }

  return nodes;
}

// --- Virtual folder builders ---

/** Parse YAML frontmatter from a SKILL.md file (lightweight). */
function parseSkillFrontmatter(content: string): { name?: string; emoji?: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) {return {};}
  const yaml = match[1];
  const result: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const kv = line.match(/^(\w+)\s*:\s*(.+)/);
    if (kv) {result[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();}
  }
  return { name: result.name, emoji: result.emoji };
}

/** Build a virtual "Skills" folder from ~/.openclaw/skills/ and ~/.openclaw/workspace/skills/. */
function buildSkillsVirtualFolder(): TreeNode | null {
  const home = homedir();
  const dirs = [
    join(home, ".openclaw", "skills"),
    join(home, ".openclaw", "workspace", "skills"),
  ];

  const children: TreeNode[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    if (!existsSync(dir)) {continue;}
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || seen.has(entry.name)) {continue;}
        const skillMdPath = join(dir, entry.name, "SKILL.md");
        if (!existsSync(skillMdPath)) {continue;}

        seen.add(entry.name);
        let displayName = entry.name;
        try {
          const content = readFileSync(skillMdPath, "utf-8");
          const meta = parseSkillFrontmatter(content);
          if (meta.name) {displayName = meta.name;}
          if (meta.emoji) {displayName = `${meta.emoji} ${displayName}`;}
        } catch {
          // skip
        }

        children.push({
          name: displayName,
          path: `~skills/${entry.name}/SKILL.md`,
          type: "document",
          virtual: true,
        });
      }
    } catch {
      // dir unreadable
    }
  }

  if (children.length === 0) {return null;}
  children.sort((a, b) => a.name.localeCompare(b.name));

  return {
    name: "Skills",
    path: "~skills",
    type: "folder",
    virtual: true,
    children,
  };
}

/**
 * Build top-level workspace root file nodes (USER.md, SOUL.md, TOOLS.md, etc.).
 * These live directly in ~/.openclaw/workspace/ but outside the dench/ subdirectory.
 * They are virtual (not movable/renamable/deletable) but editable.
 */
function buildWorkspaceRootFiles(): TreeNode[] {
  const workspaceDir = join(homedir(), ".openclaw", "workspace");
  if (!existsSync(workspaceDir)) {return [];}

  // Files already handled by the Memories virtual folder
  const SKIP_FILES = new Set(["MEMORY.md", "memory.md"]);

  const nodes: TreeNode[] = [];

  try {
    const entries = readdirSync(workspaceDir, { withFileTypes: true });
    for (const entry of entries) {
      // Skip subdirectories (handled elsewhere) and hidden files
      if (entry.isDirectory()) {continue;}
      if (entry.name.startsWith(".")) {continue;}
      if (SKIP_FILES.has(entry.name)) {continue;}

      const ext = entry.name.split(".").pop()?.toLowerCase();
      const isDocument = ext === "md" || ext === "mdx";

      nodes.push({
        name: entry.name,
        path: `~workspace/${entry.name}`,
        type: isDocument ? "document" : "file",
        virtual: true,
      });
    }
  } catch {
    // dir unreadable
  }

  // Sort alphabetically
  nodes.sort((a, b) => a.name.localeCompare(b.name));
  return nodes;
}

/** Build a virtual "Memories" folder from ~/.openclaw/workspace/. */
function buildMemoriesVirtualFolder(): TreeNode | null {
  const workspaceDir = join(homedir(), ".openclaw", "workspace");
  const children: TreeNode[] = [];

  // MEMORY.md
  for (const filename of ["MEMORY.md", "memory.md"]) {
    const memPath = join(workspaceDir, filename);
    if (existsSync(memPath)) {
      children.push({
        name: "MEMORY.md",
        path: `~memories/MEMORY.md`,
        type: "document",
        virtual: true,
      });
      break;
    }
  }

  // Daily logs from memory/
  const memoryDir = join(workspaceDir, "memory");
  if (existsSync(memoryDir)) {
    try {
      const entries = readdirSync(memoryDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) {continue;}
        children.push({
          name: entry.name,
          path: `~memories/${entry.name}`,
          type: "document",
          virtual: true,
        });
      }
    } catch {
      // dir unreadable
    }
  }

  if (children.length === 0) {return null;}
  // Sort: MEMORY.md first, then reverse chronological for daily logs
  children.sort((a, b) => {
    if (a.name === "MEMORY.md") {return -1;}
    if (b.name === "MEMORY.md") {return 1;}
    return b.name.localeCompare(a.name);
  });

  return {
    name: "Memories",
    path: "~memories",
    type: "folder",
    virtual: true,
    children,
  };
}

export async function GET() {
  const root = resolveDenchRoot();
  if (!root) {
    // Even without a dench workspace, return virtual folders if they exist
    const tree: TreeNode[] = [];
    tree.push(...buildWorkspaceRootFiles());
    const skillsFolder = buildSkillsVirtualFolder();
    if (skillsFolder) {tree.push(skillsFolder);}
    const memoriesFolder = buildMemoriesVirtualFolder();
    if (memoriesFolder) {tree.push(memoriesFolder);}
    return Response.json({ tree, exists: false, workspaceRoot: null });
  }

  // Load objects from DuckDB for smart directory detection
  const dbObjects = loadDbObjects();

  // Scan the entire dench root -- the dench folder IS the knowledge base.
  // All top-level directories (manufacturing, knowledge, reports, etc.)
  // and files are visible in the sidebar.
  const tree = buildTree(root, "", dbObjects);

  // Workspace root files (USER.md, SOUL.md, etc.) -- editable but reserved
  const workspaceRootFiles = buildWorkspaceRootFiles();
  if (workspaceRootFiles.length > 0) {tree.push(...workspaceRootFiles);}

  // Virtual folders go after all real files/folders
  const skillsFolder = buildSkillsVirtualFolder();
  if (skillsFolder) {tree.push(skillsFolder);}
  const memoriesFolder = buildMemoriesVirtualFolder();
  if (memoriesFolder) {tree.push(memoriesFolder);}

  return Response.json({ tree, exists: true, workspaceRoot: root });
}
