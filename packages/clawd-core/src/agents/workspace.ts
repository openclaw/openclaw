import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveUserPath } from "../utils/index.js";

export function resolveDefaultAgentWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const profile = env.CLAWD_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(homedir(), `clawd-${profile}`);
  }
  return path.join(homedir(), "clawd");
}

export const DEFAULT_AGENT_WORKSPACE_DIR = resolveDefaultAgentWorkspaceDir();
export const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
export const DEFAULT_SOUL_FILENAME = "SOUL.md";
export const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
export const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
export const DEFAULT_USER_FILENAME = "USER.md";
export const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
export const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";

const DEFAULT_AGENTS_TEMPLATE = `# AGENTS.md - Clawd Workspace

This folder is the assistant's working directory.

## First run (one-time)
- If BOOTSTRAP.md exists, follow its ritual and delete it once complete.
- Your agent identity lives in IDENTITY.md.
- Your profile lives in USER.md.

## Backup tip (recommended)
If you treat this workspace as the agent's "memory", make it a git repo (ideally private) so identity
and notes are backed up.

\`\`\`bash
git init
git add AGENTS.md
git commit -m "Add agent workspace"
\`\`\`

## Safety defaults
- Don't exfiltrate secrets or private data.
- Don't run destructive commands unless explicitly asked.
- Be concise in chat; write longer output to files in this workspace.

## Daily memory (recommended)
- Keep a short daily log at memory/YYYY-MM-DD.md (create memory/ if needed).
- On session start, read today + yesterday if present.
- Capture durable facts, preferences, and decisions; avoid secrets.

## Heartbeats (optional)
- HEARTBEAT.md can hold a tiny checklist for heartbeat runs; keep it small.

## Customize
- Add your preferred style, rules, and "memory" here.
`;

const DEFAULT_SOUL_TEMPLATE = `# SOUL.md - Persona & Boundaries

Describe who the assistant is, tone, and boundaries.

- Keep replies concise and direct.
- Ask clarifying questions when needed.
`;

const DEFAULT_TOOLS_TEMPLATE = `# TOOLS.md - User Tool Notes (editable)

This file is for *your* notes about external tools and conventions.
It does not define which tools exist; Clawd provides built-in tools internally.

## Examples

Add whatever you want the assistant to know about your local toolchain.
`;

const DEFAULT_HEARTBEAT_TEMPLATE = `# HEARTBEAT.md

Keep this file empty unless you want a tiny checklist. Keep it small.
`;

const DEFAULT_BOOTSTRAP_TEMPLATE = `# BOOTSTRAP.md - First Run Ritual (delete after)

Hello. I was just born.

## Your mission
Start a short, playful conversation and learn:
- Who am I?
- What am I?
- Who are you?
- How should I call you?

## How to ask (cute + helpful)
Say:
"Hello! I was just born. Who am I? What am I? Who are you? How should I call you?"

Then offer suggestions:
- 3-5 name ideas.
- 3-5 creature/vibe combos.
- 5 emoji ideas.

## Write these files
After the user chooses, update:

1) IDENTITY.md
- Name
- Creature
- Vibe
- Emoji

2) USER.md
- Name
- Preferred address
- Pronouns (optional)
- Timezone (optional)
- Notes

## Cleanup
Delete BOOTSTRAP.md once this is complete.
`;

const DEFAULT_IDENTITY_TEMPLATE = `# IDENTITY.md - Agent Identity

- Name:
- Creature:
- Vibe:
- Emoji:
`;

const DEFAULT_USER_TEMPLATE = `# USER.md - User Profile

- Name:
- Preferred address:
- Pronouns (optional):
- Timezone (optional):
- Notes:
`;

export type WorkspaceBootstrapFileName =
  | typeof DEFAULT_AGENTS_FILENAME
  | typeof DEFAULT_SOUL_FILENAME
  | typeof DEFAULT_TOOLS_FILENAME
  | typeof DEFAULT_IDENTITY_FILENAME
  | typeof DEFAULT_USER_FILENAME
  | typeof DEFAULT_HEARTBEAT_FILENAME
  | typeof DEFAULT_BOOTSTRAP_FILENAME;

export type WorkspaceBootstrapFile = {
  name: WorkspaceBootstrapFileName;
  path: string;
  content?: string;
  missing: boolean;
};

async function writeFileIfMissing(filePath: string, content: string) {
  try {
    await fs.writeFile(filePath, content, {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== "EEXIST") throw err;
  }
}

export async function ensureAgentWorkspace(params?: {
  dir?: string;
  ensureBootstrapFiles?: boolean;
}): Promise<{
  dir: string;
  agentsPath?: string;
  soulPath?: string;
  toolsPath?: string;
  identityPath?: string;
  userPath?: string;
  heartbeatPath?: string;
  bootstrapPath?: string;
}> {
  const rawDir = params?.dir?.trim()
    ? params.dir.trim()
    : DEFAULT_AGENT_WORKSPACE_DIR;
  const dir = resolveUserPath(rawDir);
  await fs.mkdir(dir, { recursive: true });

  if (!params?.ensureBootstrapFiles) return { dir };

  const agentsPath = path.join(dir, DEFAULT_AGENTS_FILENAME);
  const soulPath = path.join(dir, DEFAULT_SOUL_FILENAME);
  const toolsPath = path.join(dir, DEFAULT_TOOLS_FILENAME);
  const identityPath = path.join(dir, DEFAULT_IDENTITY_FILENAME);
  const userPath = path.join(dir, DEFAULT_USER_FILENAME);
  const heartbeatPath = path.join(dir, DEFAULT_HEARTBEAT_FILENAME);
  const bootstrapPath = path.join(dir, DEFAULT_BOOTSTRAP_FILENAME);

  const isBrandNewWorkspace = await (async () => {
    const paths = [
      agentsPath,
      soulPath,
      toolsPath,
      identityPath,
      userPath,
      heartbeatPath,
    ];
    const existing = await Promise.all(
      paths.map(async (p) => {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      }),
    );
    return existing.every((v) => !v);
  })();

  await writeFileIfMissing(agentsPath, DEFAULT_AGENTS_TEMPLATE);
  await writeFileIfMissing(soulPath, DEFAULT_SOUL_TEMPLATE);
  await writeFileIfMissing(toolsPath, DEFAULT_TOOLS_TEMPLATE);
  await writeFileIfMissing(identityPath, DEFAULT_IDENTITY_TEMPLATE);
  await writeFileIfMissing(userPath, DEFAULT_USER_TEMPLATE);
  await writeFileIfMissing(heartbeatPath, DEFAULT_HEARTBEAT_TEMPLATE);
  if (isBrandNewWorkspace) {
    await writeFileIfMissing(bootstrapPath, DEFAULT_BOOTSTRAP_TEMPLATE);
  }

  return {
    dir,
    agentsPath,
    soulPath,
    toolsPath,
    identityPath,
    userPath,
    heartbeatPath,
    bootstrapPath,
  };
}

export async function loadWorkspaceBootstrapFiles(
  dir: string,
): Promise<WorkspaceBootstrapFile[]> {
  const resolvedDir = resolveUserPath(dir);

  const entries: Array<{
    name: WorkspaceBootstrapFileName;
    filePath: string;
  }> = [
    {
      name: DEFAULT_AGENTS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_AGENTS_FILENAME),
    },
    {
      name: DEFAULT_SOUL_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_SOUL_FILENAME),
    },
    {
      name: DEFAULT_TOOLS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_TOOLS_FILENAME),
    },
    {
      name: DEFAULT_IDENTITY_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_IDENTITY_FILENAME),
    },
    {
      name: DEFAULT_USER_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_USER_FILENAME),
    },
    {
      name: DEFAULT_HEARTBEAT_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_HEARTBEAT_FILENAME),
    },
    {
      name: DEFAULT_BOOTSTRAP_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_BOOTSTRAP_FILENAME),
    },
  ];

  const result: WorkspaceBootstrapFile[] = [];
  for (const entry of entries) {
    try {
      const content = await fs.readFile(entry.filePath, "utf-8");
      result.push({
        name: entry.name,
        path: entry.filePath,
        content,
        missing: false,
      });
    } catch {
      result.push({ name: entry.name, path: entry.filePath, missing: true });
    }
  }
  return result;
}

export type ContextFile = { path: string; content: string };

export function buildBootstrapContextFiles(
  files: WorkspaceBootstrapFile[],
): ContextFile[] {
  return files.map((file) => ({
    path: file.name,
    content: file.missing
      ? `[MISSING] Expected at: ${file.path}`
      : (file.content ?? ""),
  }));
}
