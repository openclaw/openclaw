import fs from "node:fs";
import path from "node:path";
import { openVerifiedFileSync } from "../../infra/safe-open-sync.js";
import { parseFrontmatter, resolveSkillInvocationPolicy } from "./frontmatter.js";
import { createSyntheticSourceInfo, type Skill } from "./skill-contract.js";
import type { ParsedSkillFrontmatter } from "./types.js";

type LoadedLocalSkill = {
  skill: Skill;
  frontmatter: ParsedSkillFrontmatter;
};

function isPathWithinRoot(rootRealPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootRealPath, candidatePath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function readSkillFileSync(params: {
  rootRealPath: string;
  filePath: string;
  maxBytes?: number;
}): string | null {
  const opened = openVerifiedFileSync({
    filePath: params.filePath,
    rejectPathSymlink: true,
    maxBytes: params.maxBytes,
  });
  if (!opened.ok) {
    return null;
  }
  try {
    if (!isPathWithinRoot(params.rootRealPath, opened.path)) {
      return null;
    }
    return fs.readFileSync(opened.fd, "utf8");
  } finally {
    fs.closeSync(opened.fd);
  }
}

function loadSingleSkillDirectory(params: {
  skillDir: string;
  source: string;
  rootRealPath: string;
  maxBytes?: number;
}): LoadedLocalSkill | null {
  const skillFilePath = path.join(params.skillDir, "SKILL.md");
  const raw = readSkillFileSync({
    rootRealPath: params.rootRealPath,
    filePath: skillFilePath,
    maxBytes: params.maxBytes,
  });
  if (!raw) {
    return null;
  }

  let frontmatter: Record<string, string>;
  try {
    frontmatter = parseFrontmatter(raw);
  } catch {
    return null;
  }

  const fallbackName = path.basename(params.skillDir).trim();
  const name = frontmatter.name?.trim() || fallbackName;
  const description = frontmatter.description?.trim();
  if (!name || !description) {
    return null;
  }
  const invocation = resolveSkillInvocationPolicy(frontmatter);
  const filePath = path.resolve(skillFilePath);
  const baseDir = path.resolve(params.skillDir);

  return {
    skill: {
      name,
      description,
      filePath,
      baseDir,
      source: params.source,
      sourceInfo: createSyntheticSourceInfo(filePath, {
        source: params.source,
        baseDir,
        scope: "project",
        origin: "top-level",
      }),
      disableModelInvocation: invocation.disableModelInvocation,
    },
    frontmatter,
  };
}

function listCandidateSkillDirs(dir: string): string[] {
  const skillDirs: string[] = [];
  const visited = new Set<string>();

  let rootRealPath: string;
  try {
    rootRealPath = fs.realpathSync(dir);
  } catch {
    return [];
  }

  const walk = (currentDir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      let isDirectory = entry.isDirectory();
      if (!isDirectory && entry.isSymbolicLink()) {
        try {
          isDirectory = fs.statSync(fullPath).isDirectory();
        } catch {
          continue;
        }
      }
      if (!isDirectory) {
        continue;
      }

      let realPath: string;
      try {
        realPath = fs.realpathSync(fullPath);
      } catch {
        continue;
      }
      if (visited.has(realPath)) {
        continue;
      }
      if (!realPath.startsWith(rootRealPath + path.sep) && realPath !== rootRealPath) {
        continue;
      }
      visited.add(realPath);

      if (fs.existsSync(path.join(fullPath, "SKILL.md"))) {
        skillDirs.push(fullPath);
        continue;
      }

      walk(fullPath);
    }
  };

  walk(dir);
  return skillDirs.toSorted((left, right) => left.localeCompare(right));
}

export function loadSkillsFromDirSafe(params: { dir: string; source: string; maxBytes?: number }): {
  skills: Skill[];
  frontmatterByFilePath: ReadonlyMap<string, ParsedSkillFrontmatter>;
} {
  const rootDir = path.resolve(params.dir);
  let rootRealPath: string;
  try {
    rootRealPath = fs.realpathSync(rootDir);
  } catch {
    return { skills: [], frontmatterByFilePath: new Map() };
  }

  const rootSkill = loadSingleSkillDirectory({
    skillDir: rootDir,
    source: params.source,
    rootRealPath,
    maxBytes: params.maxBytes,
  });
  if (rootSkill) {
    return {
      skills: [rootSkill.skill],
      frontmatterByFilePath: new Map([[rootSkill.skill.filePath, rootSkill.frontmatter]]),
    };
  }

  const loadedSkills = listCandidateSkillDirs(rootDir)
    .map((skillDir) =>
      loadSingleSkillDirectory({
        skillDir,
        source: params.source,
        rootRealPath,
        maxBytes: params.maxBytes,
      }),
    )
    .filter((skill): skill is LoadedLocalSkill => skill !== null);
  const frontmatterByFilePath = new Map<string, ParsedSkillFrontmatter>();
  for (const loaded of loadedSkills) {
    frontmatterByFilePath.set(loaded.skill.filePath, loaded.frontmatter);
  }

  return {
    skills: loadedSkills.map((loaded) => loaded.skill),
    frontmatterByFilePath,
  };
}

export function readSkillFrontmatterSafe(params: {
  rootDir: string;
  filePath: string;
  maxBytes?: number;
}): Record<string, string> | null {
  let rootRealPath: string;
  try {
    rootRealPath = fs.realpathSync(path.resolve(params.rootDir));
  } catch {
    return null;
  }
  const raw = readSkillFileSync({
    rootRealPath,
    filePath: path.resolve(params.filePath),
    maxBytes: params.maxBytes,
  });
  if (!raw) {
    return null;
  }
  try {
    return parseFrontmatter(raw);
  } catch {
    return null;
  }
}
