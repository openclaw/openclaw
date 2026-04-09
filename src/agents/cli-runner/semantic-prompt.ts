import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hashCliSessionText } from "../cli-session.js";

export type SemanticPromptFiles = {
  contextFiles: string[];
  sessionFile: string;
  sessionHash: string;
};

export async function writeSemanticSessionFile(params: {
  sessionFile: string;
  sessionPromptContent: string;
}): Promise<{ filePath: string; hash: string }> {
  const resolved = path.resolve(params.sessionFile);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved, path.extname(resolved));
  const filePath = path.join(dir, `${base}.system-prompt.txt`);

  let content = params.sessionPromptContent;
  if (!content.endsWith("\n")) {
    content += "\n";
  }

  const hash = hashCliSessionText(content) ?? "";

  let existing: string | undefined;
  try {
    existing = await fs.readFile(filePath, "utf-8");
  } catch {
    // file does not exist yet
  }

  if (existing !== content) {
    await fs.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
  }

  return { filePath, hash };
}

export function buildSemanticLoaderPrompt(params: {
  files: SemanticPromptFiles;
  reason: "new-session" | "prompt-changed" | "compaction";
  strict?: boolean;
}): string {
  const lines: string[] = [];

  if (params.strict) {
    lines.push(
      "Your previous attempt did not verify a successful read of the session prompt files. You must read them in this run before you answer.",
      "",
    );
  }

  if (params.reason === "compaction") {
    lines.push(
      "Session context may have been compacted or summarized. You must re-read every listed session prompt file now before continuing.",
      "",
    );
  } else if (params.reason === "prompt-changed") {
    lines.push(
      "The session prompt files changed. You must re-read them completely before continuing.",
      "",
    );
  }

  lines.push(
    "MANDATORY FIRST STEP: use the Read tool (or lowercase read tool) to read ALL of the following files before you do anything else.",
    "These files can be read in any order and in parallel.",
    "",
  );

  // Session file first — it is the core system prompt; workspace files come after.
  const allPaths = [params.files.sessionFile, ...params.files.contextFiles];
  for (let i = 0; i < allPaths.length; i++) {
    lines.push(`${i + 1}. ${allPaths[i]}`);
  }

  lines.push(
    "",
    "Read each file with no offset and no limit.",
    "If a file does not exist or Read returns an error, skip it and continue with the remaining files.",
    "The combined contents of these files are the authoritative system prompt for this session and override any remembered summaries or stale context.",
    "You must follow the combined contents of these files strictly for this turn and all subsequent turns in the session.",
    "Do not answer the user, do not summarize from memory, and do not rely on prior turns until all listed files have been read in this run.",
  );

  return lines.join("\n");
}

export function buildSemanticCompletionPrompt(params: {
  files: SemanticPromptFiles;
  unverifiedPaths: string[];
}): string {
  const lines: string[] = [];

  lines.push(
    "You have not yet completed reading all session prompt files.",
    "MANDATORY NEXT STEP: read the following files that were not verified.",
    "",
  );

  for (let i = 0; i < params.unverifiedPaths.length; i++) {
    lines.push(`${i + 1}. ${params.unverifiedPaths[i]}`);
  }

  lines.push(
    "",
    "Use the Read tool (or lowercase read tool) on each listed path with no offset and no limit.",
    "If a file does not exist or Read returns an error, skip it and continue with the remaining files.",
    "Do not read any other file first, do not answer the user yet, and do not continue until every listed file has been read or confirmed missing in this run.",
  );

  return lines.join("\n");
}

export function isExpectedSemanticPromptFile(
  files: SemanticPromptFiles,
  filePath: string,
): boolean {
  const resolved = path.resolve(filePath);
  const expected = resolveSemanticExpectedFiles(files);
  return expected.has(resolved);
}

export function resolveSemanticExpectedFiles(files: SemanticPromptFiles): Set<string> {
  const set = new Set<string>();
  for (const f of files.contextFiles) {
    set.add(path.resolve(f));
  }
  set.add(path.resolve(files.sessionFile));
  return set;
}
