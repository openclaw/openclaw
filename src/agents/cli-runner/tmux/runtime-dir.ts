import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import type { TmuxRuntimePaths } from "./types.js";

export function resolveTmuxRuntimePaths(params: {
  runtimeDir?: string;
  sessionName: string;
}): TmuxRuntimePaths {
  const rootBase =
    params.runtimeDir?.trim() || path.join(resolvePreferredOpenClawTmpDir(), "claude-tmux");
  const rootDir = path.join(rootBase, params.sessionName);
  return {
    rootDir,
    activeRunFile: path.join(rootDir, "active-run.json"),
    eventsFile: path.join(rootDir, "events.jsonl"),
    paneLogFile: path.join(rootDir, "pane.log"),
    launcherFile: path.join(rootDir, "launch-claude.mjs"),
    managedSettingsFile: path.join(rootDir, "managed-settings.json"),
    settingsFile: path.join(rootDir, "settings.json"),
    systemPromptFile: path.join(rootDir, "system-prompt.txt"),
    hookWriterFile: path.join(rootDir, "hook-writer.mjs"),
    promptBufferFile: path.join(rootDir, "prompt-buffer.txt"),
    metadataFile: path.join(rootDir, "metadata.json"),
  };
}

export async function ensureTmuxRuntimeDir(paths: TmuxRuntimePaths): Promise<void> {
  await fs.mkdir(paths.rootDir, { recursive: true, mode: 0o700 });
}
