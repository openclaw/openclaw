import fs from "node:fs/promises";
import path from "node:path";

const PROTOCOL_SCHEMA_RELATIVE_PATH = "codex-rs/app-server-protocol/schema";

export async function resolveCodexAppServerProtocolSource(repoRoot: string): Promise<{
  codexRepo: string;
  sourceRoot: string;
}> {
  const candidates = await collectCodexRepoCandidates(repoRoot);
  const checked: string[] = [];

  for (const candidate of candidates) {
    const codexRepo = path.resolve(candidate);
    if (checked.includes(codexRepo)) {
      continue;
    }
    checked.push(codexRepo);
    const sourceRoot = path.join(codexRepo, PROTOCOL_SCHEMA_RELATIVE_PATH);
    if (await isDirectory(path.join(sourceRoot, "typescript"))) {
      return { codexRepo, sourceRoot };
    }
  }

  throw new Error(
    [
      "Codex app-server protocol schema not found.",
      "Set OPENCLAW_CODEX_REPO to a checkout of openai/codex, or keep a sibling `codex` checkout next to the primary OpenClaw checkout.",
      `Checked: ${checked.join(", ") || "<none>"}`,
    ].join("\n"),
  );
}

async function collectCodexRepoCandidates(repoRoot: string): Promise<string[]> {
  const candidates = [
    process.env.OPENCLAW_CODEX_REPO,
    path.resolve(repoRoot, "../codex"),
    await resolvePrimaryWorktreeSiblingCodex(repoRoot),
  ];
  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

async function resolvePrimaryWorktreeSiblingCodex(repoRoot: string): Promise<string | undefined> {
  const gitFilePath = path.join(repoRoot, ".git");
  let gitFile: string;
  try {
    gitFile = await fs.readFile(gitFilePath, "utf8");
  } catch {
    return undefined;
  }

  const match = /^gitdir:\s*(.+)$/m.exec(gitFile);
  if (!match) {
    return undefined;
  }

  const gitDir = path.resolve(repoRoot, match[1].trim());
  const worktreeMarker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  const markerIndex = gitDir.indexOf(worktreeMarker);
  if (markerIndex < 0) {
    return undefined;
  }

  const primaryWorktreeRoot = gitDir.slice(0, markerIndex);
  return path.join(path.dirname(primaryWorktreeRoot), "codex");
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}
