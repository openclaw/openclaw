import { lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stringify } from "yaml";
import { renderGrokBotAvatar } from "./avatar.js";
import type { GrokBotImportWarning, GrokBotRecipe } from "./recipe.js";

export type GrokBotConversionResult = {
  packageRoot: string;
  manifestPath: string;
  completeness: "complete" | "partial";
  counts: { memories: number; skills: number; routines: number; plugins: number };
  requiresReview: { routines: string[]; plugins: string[] };
  warnings: GrokBotImportWarning[];
};

function slug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "grok-bot"
  );
}

function uniqueSlug(value: string, kind: "skill" | "routine", used: Set<string>): string {
  let base = slug(value);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(base)) {
    base = `${kind}-${base}`;
  }
  let result = base;
  for (let i = 2; used.has(result); i++) {
    result = `${base}-${i}`;
  }
  used.add(result);
  return result;
}

async function assertEmptyDestination(destination: string): Promise<void> {
  const existing = await lstat(destination).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    throw new Error("Grok Bot destination must not be a symlink.");
  }
  if (existing && (!existing.isDirectory() || (await readdir(destination)).length)) {
    throw new Error(
      "Grok Bot destination must be a new or empty directory; existing files are never overwritten.",
    );
  }
}

export async function convertGrokBotRecipe(params: {
  recipe: GrokBotRecipe;
  destination: string;
  identitySuffix?: string;
}): Promise<GrokBotConversionResult> {
  const { recipe } = params;
  const packageRoot = resolve(params.destination);
  await assertEmptyDestination(packageRoot);
  const nameSlug = slug(recipe.profile.name);
  let agentId = /^[a-z]/.test(nameSlug) ? nameSlug : `bot-${nameSlug}`;
  if (params.identitySuffix !== undefined) {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(params.identitySuffix)) {
      throw new Error(
        "Grok Bot identity suffix must contain 1–32 lowercase letters, digits, or hyphens and start with a letter or digit.",
      );
    }
    agentId = `${agentId.slice(0, 63 - params.identitySuffix.length).replace(/-+$/g, "")}-${params.identitySuffix}`;
  }
  const completeness = recipe.sourceLimitations?.length ? "partial" : "complete";
  const warnings: GrokBotImportWarning[] = [...(recipe.sourceLimitations ?? [])];
  const files = new Map<string, string | Uint8Array>();
  const workspaceFiles: Array<{ source: string; path: string }> = [];
  const addWorkspaceFile = (path: string, content: string | Uint8Array) => {
    const source = `workspace/${path}`;
    files.set(source, content);
    workspaceFiles.push({ source, path });
  };
  let avatarPath: string | undefined;
  if (recipe.avatarImage) {
    if (!/^(png|jpg|gif|webp)$/.test(recipe.avatarImage.extension)) {
      throw new Error("Grok Bot avatar image must have a verified supported image extension.");
    }
    avatarPath = `assets/grok-bot-avatar.${recipe.avatarImage.extension}`;
    addWorkspaceFile(avatarPath, recipe.avatarImage.bytes);
  } else if (recipe.profile.avatarShape !== undefined || recipe.profile.avatarColor !== undefined) {
    const avatar = renderGrokBotAvatar(recipe.profile.avatarShape, recipe.profile.avatarColor);
    avatarPath = "assets/grok-bot-avatar.svg";
    addWorkspaceFile(avatarPath, avatar.svg);
    warnings.push(...avatar.warnings);
  }
  if (recipe.memory.length) {
    addWorkspaceFile(
      "MEMORY.md",
      `# Imported Grok Bot memory\n\n${recipe.memory.map((item) => `## ${item.kind ?? "memory"}${item.createdAt ? ` · ${item.createdAt}` : ""}\n\n${item.content}`).join("\n\n")}\n`,
    );
  }
  const usedSkillSlugs = new Set<string>();
  const skillPaths = recipe.skills.map((skill) => {
    const skillSlug = uniqueSlug(skill.name, "skill", usedSkillSlugs);
    const path = `skills/${skillSlug}/SKILL.md`;
    const content = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(skill.content)
      ? skill.content
      : `---\n${stringify({ name: skillSlug, description: skill.description })}---\n\n${skill.content}`;
    addWorkspaceFile(path, content);
    return path;
  });
  const usedRoutineSlugs = new Set<string>();
  const routinePaths = recipe.routines.map((routine) => {
    const path = `routines/${uniqueSlug(routine.slug || routine.name, "routine", usedRoutineSlugs)}/ROUTINE.md`;
    addWorkspaceFile(path, routine.content);
    return path;
  });
  const setup = [
    "# Grok Bot import setup",
    "",
    "This package contains the available bot instructions and source content. Review any import warnings below for data Grok could not provide. Grok-specific tool names and capabilities may need an OpenClaw equivalent.",
    "",
    "## Routines",
    "",
    "No routines are enabled or scheduled by this import. Review each saved routine, choose its timezone and delivery destination, and explicitly enable the routines you want using OpenClaw cron after setup.",
    ...recipe.routines.map(
      (routine, i) =>
        `\n### ${JSON.stringify(routine.name)}\n\n${routine.description}\n\nSaved instructions: ${routinePaths[i]}\nOriginal slug: ${JSON.stringify(routine.slug)}`,
    ),
    "",
    "## Integrations",
    "",
    "Grok plugin IDs are source metadata, not OpenClaw package names. No plugins or MCP servers were installed or enabled. For each integration below, choose a supported OpenClaw plugin, MCP server, or manual alternative; connect your own account, verify its permissions, and test it before using dependent skills. Imported plugin metadata does not configure authentication.",
    "",
    "Original integration metadata:",
    "",
    "```json",
    JSON.stringify(recipe.plugins, null, 2),
    "```",
    "",
  ].join("\n");
  addWorkspaceFile("GROK-IMPORT.md", setup);
  let bootstrap =
    "Read GROK-IMPORT.md before first use. Imported routines are not scheduled; complete integration setup before using dependent capabilities.\n";
  if (completeness === "partial") {
    bootstrap +=
      "\nThis import is incomplete because Grok did not provide all source data. Read the import warnings in GROK-IMPORT.md before claiming that the bot's memory or integration requirements were fully imported.\n";
  }
  if (recipe.gettingStarted) {
    const index = recipe.skills.findIndex((skill) => skill.name === recipe.gettingStarted?.skill);
    if (index >= 0) {
      bootstrap += `\nThen read ${skillPaths[index]} and follow its getting-started instructions with the user.\n`;
    } else {
      warnings.push({
        code: "getting_started_skill_missing",
        message: `Getting-started skill ${JSON.stringify(recipe.gettingStarted.skill)} was not included; choose a setup skill manually.`,
      });
    }
  }
  files.set("BOOTSTRAP.md", bootstrap);
  if (warnings.length) {
    files.set(
      "workspace/GROK-IMPORT.md",
      `${setup}\n## Import warnings\n\n${warnings.map((warning) => `- ${warning.code}: ${warning.message}`).join("\n")}\n`,
    );
  }
  const manifest = {
    schemaVersion: 1,
    agent: {
      id: agentId,
      name: recipe.profile.name.trim(),
      ...(recipe.profile.title?.trim() ? { description: recipe.profile.title.trim() } : {}),
      identity: {
        name: recipe.profile.name.trim(),
        ...(avatarPath ? { avatar: avatarPath } : {}),
      },
    },
    workspace: { bootstrapFiles: {}, files: workspaceFiles },
    packages: [],
    mcpServers: {},
    cronJobs: [],
  };
  const manifestPath = join(packageRoot, "CLAW.md");
  files.set("CLAW.md", `---\n${stringify(manifest)}---\n\n${recipe.profile.description}\n`);
  files.set(
    "package.json",
    `${JSON.stringify({ name: `${agentId}-claw`, version: "1.0.0", type: "module", description: "Imported from a Grok Bot recipe.", openclaw: { claw: "CLAW.md" } }, null, 2)}\n`,
  );
  // These are native Claw artifact limits, not Grok's larger recipe upload limit.
  let workspaceBytes = 0;
  for (const [path, content] of files) {
    const bytes =
      typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;
    const limit =
      path === "BOOTSTRAP.md"
        ? 2 * 1024 * 1024
        : path === "package.json"
          ? 256 * 1024
          : 1024 * 1024;
    if (bytes > limit) {
      throw new Error(
        `Converted ${path} exceeds the native Claw ${limit / (1024 * 1024)} MiB file limit. Split or reduce this recipe before importing.`,
      );
    }
    if (path.startsWith("workspace/")) {
      workspaceBytes += bytes;
    }
  }
  if (workspaceBytes > 4 * 1024 * 1024) {
    throw new Error(
      "Converted workspace exceeds the native Claw 4 MiB total limit. Split or reduce this recipe before importing.",
    );
  }
  await mkdir(dirname(packageRoot), { recursive: true });
  const staging = await mkdtemp(join(dirname(packageRoot), ".grok-bot-import-"));
  try {
    for (const [path, content] of files) {
      await mkdir(dirname(join(staging, path)), { recursive: true });
      await writeFile(join(staging, path), content, { flag: "wx", mode: 0o600 });
    }
    await assertEmptyDestination(packageRoot);
    await rename(staging, packageRoot);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return {
    packageRoot,
    manifestPath,
    completeness,
    counts: {
      memories: recipe.memory.length,
      skills: recipe.skills.length,
      routines: recipe.routines.length,
      plugins: recipe.plugins.length,
    },
    requiresReview: {
      routines: recipe.routines.map((routine) => routine.name),
      plugins: recipe.plugins.map((plugin) => plugin.name),
    },
    warnings,
  };
}
