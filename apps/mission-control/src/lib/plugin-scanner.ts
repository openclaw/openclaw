import fs from "fs";
import path from "path";

// --- Types ---

export interface PluginSkill {
  name: string;
  path: string;
  description?: string;
}

export interface PluginAgent {
  name: string;
  path: string;
}

export interface PluginMcpServer {
  name: string;
  type: string; // "http" | "stdio" | "sse"
  url?: string;
  command?: string;
}

export interface PluginEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  category: string;
  scope: "official" | "local";
  installPath: string;
  skills: PluginSkill[];
  agents: PluginAgent[];
  commands: string[];
  hooks: string[];
  mcpServers: PluginMcpServer[];
  isSymlinked: boolean;
  installedAt?: string;
}

export interface PluginCatalog {
  plugins: PluginEntry[];
  totalSkills: number;
  totalAgents: number;
  totalMcpServers: number;
  categories: string[];
  scannedAt: string;
}

// --- Category classification ---

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  engineering: [
    "typescript-lsp", "pyright-lsp", "gopls-lsp", "php-lsp", "csharp-lsp",
    "rust-analyzer-lsp", "code-review", "code-simplifier", "feature-dev",
    "frontend-design", "pr-review-toolkit", "commit-commands", "laravel-boost",
  ],
  "ai-ml": [
    "ai-ml-tools", "ai-agency", "huggingface", "agent-sdk-dev",
    "skill-enhancers", "superpowers",
  ],
  business: [
    "business-skills", "business-pack", "family-office-os",
  ],
  security: [
    "security-guidance", "security-tools",
  ],
  devops: [
    "devops-tools", "vercel",
  ],
  database: [
    "database-tools", "supabase",
  ],
  api: [
    "api-tools",
  ],
  testing: [
    "testing-tools",
  ],
  performance: [
    "performance-tools",
  ],
  crypto: [
    "crypto-defi",
  ],
  productivity: [
    "productivity-pack", "overnight-dev", "hookify",
    "explanatory-output-style", "learning-output-style",
    "ralph-loop", "plugin-dev",
  ],
  saas: [
    "saas-packs", "sentry", "Notion", "atlassian", "figma",
    "gitlab", "greptile", "linear", "playwright",
  ],
  document: [
    "document-skills",
  ],
  integration: [
    "github", "context7", "serena",
  ],
};

function classifyPlugin(pluginId: string): string {
  const idLower = pluginId.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      if (idLower.includes(kw.toLowerCase())) {
        return category;
      }
    }
  }
  return "custom";
}

// --- File-system scanning helpers ---

const HOME = process.env.HOME || "/Users/a-binghaith";
const INSTALLED_PLUGINS_PATH = path.join(
  HOME, ".claude", "plugins", "installed_plugins.json"
);

interface InstalledPluginInstallation {
  scope?: string;
  projectPath?: string;
  installPath: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
  gitCommitSha?: string;
}

interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, InstalledPluginInstallation[]>;
}

interface PluginManifest {
  name?: string;
  description?: string;
  version?: string;
  author?: string | { name?: string; email?: string };
  mcpServers?: Record<
    string,
    { type?: string; url?: string; command?: string }
  >;
}

function safeReadJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {return null;}
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Find skill.md / SKILL.md files recursively inside a directory.
 * Excludes backup directories to avoid picking up thousands of old copies.
 */
function findSkillFiles(
  dir: string
): { name: string; filePath: string }[] {
  const results: { name: string; filePath: string }[] = [];
  if (!fs.existsSync(dir)) {return results;}

  function walk(current: string, depth: number): void {
    if (depth > 6) {return;}
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // Skip backup dirs, node_modules, .git
        if (
          entry.name === "backups" ||
          entry.name === "node_modules" ||
          entry.name === ".git"
        ) {
          continue;
        }
        walk(fullPath, depth + 1);
      } else if (
        entry.isFile() &&
        (entry.name === "skill.md" || entry.name === "SKILL.md")
      ) {
        const skillName = path.basename(current);
        results.push({ name: skillName, filePath: fullPath });
      }
    }
  }

  walk(dir, 0);
  return results;
}

/**
 * Find agent .md files inside agents/ directories.
 */
function findAgentFiles(
  dir: string
): { name: string; filePath: string }[] {
  const agentsDir = path.join(dir, "agents");
  if (!fs.existsSync(agentsDir)) {return [];}

  const results: { name: string; filePath: string }[] = [];
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const agentName = entry.name.replace(/\.md$/, "");
        results.push({
          name: agentName,
          filePath: path.join(agentsDir, entry.name),
        });
      }
    }
  } catch {
    // ignore read errors
  }
  return results;
}

/**
 * Find command .md files inside commands/ directories.
 */
function findCommandFiles(dir: string): string[] {
  const commandsDir = path.join(dir, "commands");
  if (!fs.existsSync(commandsDir)) {return [];}

  const results: string[] = [];
  try {
    const entries = fs.readdirSync(commandsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(entry.name.replace(/\.md$/, ""));
      }
    }
  } catch {
    // ignore read errors
  }
  return results;
}

/**
 * Find hook files inside hooks/ directory.
 */
function findHookFiles(dir: string): string[] {
  const hooksDir = path.join(dir, "hooks");
  if (!fs.existsSync(hooksDir)) {return [];}

  const results: string[] = [];
  try {
    const entries = fs.readdirSync(hooksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        results.push(entry.name);
      }
    }
  } catch {
    // ignore read errors
  }
  return results;
}

/**
 * Check if any entry inside a skills/ directory is a symlink.
 */
function hasSymlinkedSkills(dir: string): boolean {
  const skillsDir = path.join(dir, "skills");
  if (!fs.existsSync(skillsDir)) {return false;}

  try {
    const entries = fs.readdirSync(skillsDir);
    for (const entry of entries) {
      const fullPath = path.join(skillsDir, entry);
      try {
        const stat = fs.lstatSync(fullPath);
        if (stat.isSymbolicLink()) {return true;}
      } catch {
        continue;
      }
    }
  } catch {
    // ignore read errors
  }
  return false;
}

/**
 * Resolve the plugin.json path. Plugins store their manifest in one of:
 *   - <installPath>/plugin.json
 *   - <installPath>/.claude-plugin/plugin.json
 */
function resolveManifestPath(installPath: string): string | null {
  const direct = path.join(installPath, "plugin.json");
  if (fs.existsSync(direct)) {return direct;}

  const nested = path.join(installPath, ".claude-plugin", "plugin.json");
  if (fs.existsSync(nested)) {return nested;}

  return null;
}

function extractAuthor(
  author: string | { name?: string; email?: string } | undefined
): string | undefined {
  if (!author) {return undefined;}
  if (typeof author === "string") {return author;}
  return author.name || undefined;
}

/**
 * Read the first few lines of a skill.md to extract its description
 * (typically the first non-heading, non-empty line).
 */
function extractSkillDescription(filePath: string): string | undefined {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {continue;}
      if (trimmed.startsWith("#")) {continue;}
      if (trimmed.startsWith("---")) {continue;}
      return trimmed.length > 200
        ? trimmed.slice(0, 200) + "..."
        : trimmed;
    }
  } catch {
    // ignore read errors
  }
  return undefined;
}

// --- Main scanner ---

export function scanPlugins(): PluginCatalog {
  const installedFile = safeReadJson<InstalledPluginsFile>(
    INSTALLED_PLUGINS_PATH
  );
  if (!installedFile || !installedFile.plugins) {
    return {
      plugins: [],
      totalSkills: 0,
      totalAgents: 0,
      totalMcpServers: 0,
      categories: [],
      scannedAt: new Date().toISOString(),
    };
  }

  const plugins: PluginEntry[] = [];
  const categorySet = new Set<string>();

  for (const [pluginKey, installations] of Object.entries(
    installedFile.plugins
  )) {
    for (const installation of installations) {
      const installPath = installation.installPath;
      if (!installPath || !fs.existsSync(installPath)) {continue;}

      // Derive plugin id from key (e.g. "sentry@claude-plugins-official" -> "sentry")
      const pluginId = pluginKey.split("@")[0];
      const scope: "official" | "local" = pluginKey.includes(
        "@claude-plugins-official"
      )
        ? "official"
        : "local";

      // Read plugin.json manifest
      const manifestPath = resolveManifestPath(installPath);
      const manifest = manifestPath
        ? safeReadJson<PluginManifest>(manifestPath)
        : null;

      // Skills
      const skillFiles = findSkillFiles(installPath);
      const skills: PluginSkill[] = skillFiles.map((sf) => ({
        name: sf.name,
        path: sf.filePath,
        description: extractSkillDescription(sf.filePath),
      }));

      // Agents
      const agentFiles = findAgentFiles(installPath);
      const agents: PluginAgent[] = agentFiles.map((af) => ({
        name: af.name,
        path: af.filePath,
      }));

      // Commands
      const commands = findCommandFiles(installPath);

      // Hooks
      const hooks = findHookFiles(installPath);

      // MCP Servers
      const mcpServers: PluginMcpServer[] = [];
      if (manifest?.mcpServers) {
        for (const [serverName, serverConfig] of Object.entries(
          manifest.mcpServers
        )) {
          mcpServers.push({
            name: serverName,
            type: serverConfig.type || "stdio",
            url: serverConfig.url,
            command: serverConfig.command,
          });
        }
      }

      // Symlink check
      const isSymlinked = hasSymlinkedSkills(installPath);

      // Category
      const category = classifyPlugin(pluginId);
      categorySet.add(category);

      plugins.push({
        id: pluginId,
        name: manifest?.name || pluginId,
        description: manifest?.description || "",
        version:
          manifest?.version || installation.version || "unknown",
        author: extractAuthor(manifest?.author),
        category,
        scope,
        installPath,
        skills,
        agents,
        commands,
        hooks,
        mcpServers,
        isSymlinked,
        installedAt: installation.installedAt,
      });
    }
  }

  const totalSkills = plugins.reduce(
    (sum, p) => sum + p.skills.length,
    0
  );
  const totalAgents = plugins.reduce(
    (sum, p) => sum + p.agents.length,
    0
  );
  const totalMcpServers = plugins.reduce(
    (sum, p) => sum + p.mcpServers.length,
    0
  );

  return {
    plugins,
    totalSkills,
    totalAgents,
    totalMcpServers,
    categories: [...categorySet].toSorted(),
    scannedAt: new Date().toISOString(),
  };
}

// --- Cache layer ---

let cachedCatalog: PluginCatalog | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function getCachedPluginCatalog(): PluginCatalog {
  const now = Date.now();
  if (cachedCatalog && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedCatalog;
  }
  cachedCatalog = scanPlugins();
  cacheTimestamp = now;
  return cachedCatalog;
}
